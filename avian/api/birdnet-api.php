<?php
// AvianVisitors - JSON facade over BirdNET-Pi's birds.db. Read-only.
// Symlinked into the BirdNET-Pi Caddy site root at /avian/api/.
//
// Endpoints (?action=...):
//   stats       - totals (detections, unique species, today, last hour)
//   lifelist    - every species with first_seen, last_seen, total_count
//   recent      - &hours=N (default 24): species heard in the window
//   species     - &sci=<sci_name>: per-species detail page
//                 (&from=&to= 'YYYY-MM-DD HH:MM:SS' narrows the detections)
//   visits      - &hours=N: every visit in the window (see below), plus
//                 sunrise / sunset for each day it covers
//   timeseries  - &days=N: daily detection counts per species
//   firstseen   - every species' earliest detection
//
// Default LAN deploy ships without auth. If you've exposed the Pi via
// Cloudflare or a tunnel, add a Caddy `basic_auth` matcher around the
// /avian/api/* path - see avian/forwarding/.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=30');
// Caddy doesn't compress these, and the Pi's Wi-Fi link is slow.
if (function_exists('ob_gzhandler') && !ini_get('zlib.output_compression')) ob_start('ob_gzhandler');

// PHP resolves __DIR__ through symlinks to the realpath. This script
// lives at $HOME/BirdNET-Pi/avian/api/birdnet-api.php (served via the
// ${EXTRACTED}/avian symlink). dirname(..., 2) walks to the BirdNET-Pi
// install root. Works under any username because we never bake the
// home directory in. getenv('HOME') would resolve to /var/lib/caddy
// under PHP-FPM (BirdNET-Pi runs it as the caddy user), so it can't
// be relied on.
$DB_PATH = dirname(__DIR__, 2) . '/scripts/birds.db';

if (!file_exists($DB_PATH)) {
    http_response_code(503);
    echo json_encode(['error' => 'birds.db not found']);
    exit;
}

try {
    $db = new SQLite3($DB_PATH, SQLITE3_OPEN_READONLY);
    $db->busyTimeout(2000);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['error' => 'db open failed']);
    exit;
}

function rows(SQLite3 $db, string $sql, array $bind = []): array {
    $stmt = $db->prepare($sql);
    foreach ($bind as $k => $v) $stmt->bindValue($k, $v);
    $res = $stmt->execute();
    $out = [];
    while ($r = $res->fetchArray(SQLITE3_ASSOC)) $out[] = $r;
    return $out;
}
function one(SQLite3 $db, string $sql, array $bind = []) {
    $r = rows($db, $sql, $bind);
    return $r[0] ?? null;
}

$action = $_GET['action'] ?? 'stats';

switch ($action) {

    case 'stats': {
        $total       = (int)(one($db, 'SELECT COUNT(*) AS n FROM detections')['n'] ?? 0);
        $species     = (int)(one($db, 'SELECT COUNT(DISTINCT Sci_Name) AS n FROM detections')['n'] ?? 0);
        $today       = (int)(one($db, "SELECT COUNT(*) AS n FROM detections WHERE Date = DATE('now','localtime')")['n'] ?? 0);
        $todaySpec   = (int)(one($db, "SELECT COUNT(DISTINCT Sci_Name) AS n FROM detections WHERE Date = DATE('now','localtime')")['n'] ?? 0);
        $lastHour    = (int)(one($db, "SELECT COUNT(*) AS n FROM detections WHERE Date = DATE('now','localtime') AND Time >= TIME('now','localtime','-1 hour')")['n'] ?? 0);
        $week        = (int)(one($db, "SELECT COUNT(*) AS n FROM detections WHERE Date >= DATE('now','localtime','-7 day')")['n'] ?? 0);
        $weekSpec    = (int)(one($db, "SELECT COUNT(DISTINCT Sci_Name) AS n FROM detections WHERE Date >= DATE('now','localtime','-7 day')")['n'] ?? 0);
        $first       = one($db, 'SELECT MIN(Date) AS d FROM detections');
        echo json_encode([
            'totals'    => ['detections' => $total, 'species' => $species],
            'today'     => ['detections' => $today, 'species' => $todaySpec],
            'last_hour' => ['detections' => $lastHour],
            'week'      => ['detections' => $week,  'species' => $weekSpec],
            'started'   => $first['d'] ?? null,
            'as_of'     => date('c'),
        ]);
        break;
    }

    case 'lifelist': {
        // n = total calls (matches the `recent` action's alias so the
        // frontend can read either response interchangeably).
        $rs = rows($db,
          "SELECT Sci_Name AS sci, Com_Name AS com, MIN(Date||' '||Time) AS first_seen, "
        . "       MAX(Date||' '||Time) AS last_seen, COUNT(*) AS n, MAX(Confidence) AS best_conf "
        . "FROM detections GROUP BY Sci_Name ORDER BY first_seen ASC"
        );
        echo json_encode(['species' => $rs, 'as_of' => date('c')]);
        break;
    }

    case 'recent': {
        // Cap raised to 1,000,000 hours (~114 years) so the frontend's
        // "ALL" button can turn off the time filter without needing a
        // separate code path.
        $hours = max(1, min(1000000, (int)($_GET['hours'] ?? 24)));
        // species-collapsed view: one row per species seen in the window,
        // with the file of its highest-confidence detection inside the window.
        $rs = rows($db,
          "SELECT Sci_Name AS sci, Com_Name AS com, COUNT(*) AS n, MAX(Confidence) AS best_conf, "
        . "       MAX(Date||' '||Time) AS last_seen "
        . "FROM detections "
        . "WHERE (julianday('now','localtime') - julianday(Date||' '||Time)) * 24 <= :hrs "
        . "GROUP BY Sci_Name ORDER BY last_seen DESC",
          [':hrs' => $hours]
        );
        // for each row, attach the file of the top-confidence detection in the window
        foreach ($rs as &$r) {
            $best = one($db,
              "SELECT File_Name AS file, Date AS d, Time AS t, Confidence AS conf "
            . "FROM detections "
            . "WHERE Sci_Name = :sn "
            . "AND (julianday('now','localtime') - julianday(Date||' '||Time)) * 24 <= :hrs "
            . "ORDER BY Confidence DESC LIMIT 1",
              [':sn' => $r['sci'], ':hrs' => $hours]
            );
            $r['top_file'] = $best['file'] ?? null;
            $r['top_at']   = isset($best['d']) ? ($best['d'].' '.$best['t']) : null;
        }
        echo json_encode(['hours' => $hours, 'species' => $rs, 'as_of' => date('c')]);
        break;
    }

    case 'species': {
        $sci = $_GET['sci'] ?? '';
        if ($sci === '') { http_response_code(400); echo json_encode(['error' => 'sci= required']); break; }
        // Optional from/to (inclusive) - the timeline asks for one visit's
        // recordings this way.
        $range = '';
        $bind = [':sn' => $sci];
        $from = $_GET['from'] ?? '';
        $to   = $_GET['to'] ?? '';
        $tsRe = '/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/';
        if (preg_match($tsRe, $from) && preg_match($tsRe, $to)) {
            $range = "AND Date||' '||Time BETWEEN :from AND :to ";
            $bind[':from'] = $from;
            $bind[':to']   = $to;
        }
        $detections = rows($db,
          "SELECT Date AS d, Time AS t, File_Name AS file, Confidence AS conf "
        . "FROM detections WHERE Sci_Name = :sn " . $range
        . "ORDER BY Date DESC, Time DESC LIMIT 500",
          $bind
        );
        $summary = one($db,
          "SELECT Com_Name AS com, COUNT(*) AS total, MIN(Date||' '||Time) AS first_seen, "
        . "       MAX(Date||' '||Time) AS last_seen, MAX(Confidence) AS best_conf "
        . "FROM detections WHERE Sci_Name = :sn",
          [':sn' => $sci]
        );
        echo json_encode(['sci' => $sci, 'summary' => $summary, 'detections' => $detections]);
        break;
    }

    case 'visits': {
        // Powers the timeline view. A visit is a run of detections of one
        // species with no gap longer than VISIT_GAP seconds, so a magpie
        // chattering for ten minutes is one bar, not two hundred. Grouping
        // here keeps the payload to hundreds of rows even over a week.
        $VISIT_GAP = 300;
        $hours = max(1, min(1000000, (int)($_GET['hours'] ?? 24)));
        // Detection times are local wall-clock; PHP runs in UTC. Take "now"
        // and the UTC offset from SQLite so both sides agree.
        $clock = one($db,
          "SELECT datetime('now','localtime') AS now, "
        . "CAST(strftime('%s','now','localtime') AS INT) - CAST(strftime('%s','now') AS INT) AS off"
        );
        $now = strtotime($clock['now'] . ' UTC');
        $off = (int)$clock['off'];
        // ALL (1,000,000h) drops the filter rather than computing julianday
        // on every row. Every time below is naive local wall-clock seconds
        // (strftime('%s') of the local Date/Time, read as if it were UTC).
        $all = $hours >= 1000000;
        $rs = rows($db,
          "SELECT Sci_Name AS sci, Com_Name AS com, Confidence AS conf, "
        . "       CAST(strftime('%s', Date||' '||Time) AS INT) AS t "
        . "FROM detections "
        . ($all ? "" : "WHERE (julianday('now','localtime') - julianday(Date||' '||Time)) * 24 <= :hrs ")
        . "ORDER BY Sci_Name, Date, Time",
          $all ? [] : [':hrs' => $hours]
        );
        // Compact rows - the ALL window runs to thousands of visits and the
        // Pi's link is slow. species: [sci, com]; visits: [species index,
        // start, seconds long, detections, best confidence %].
        $species = [];
        $spIdx = [];
        $visits = [];
        $cur = null;
        foreach ($rs as $r) {
            $t = (int)$r['t'];
            $pct = (int)round($r['conf'] * 100);
            if ($cur && $cur[0] === $spIdx[$r['sci']] && $t - $cur[5] <= $VISIT_GAP) {
                $cur[5] = $t;
                $cur[3]++;
                if ($pct > $cur[4]) $cur[4] = $pct;
                continue;
            }
            if ($cur) { $cur[2] = $cur[5] - $cur[1]; $visits[] = array_slice($cur, 0, 5); }
            if (!isset($spIdx[$r['sci']])) { $spIdx[$r['sci']] = count($species); $species[] = [$r['sci'], $r['com']]; }
            $cur = [$spIdx[$r['sci']], $t, 0, 1, $pct, $t];
        }
        if ($cur) { $cur[2] = $cur[5] - $cur[1]; $visits[] = array_slice($cur, 0, 5); }

        // Sunrise / sunset per day, for the night shading. Skipped past a
        // month - at that scale the bands are just noise.
        $sun = [];
        $conf = [];
        $confPath = dirname(__DIR__, 2) . '/birdnet.conf';
        if (is_readable($confPath) && preg_match_all('/^(LATITUDE|LONGITUDE)="?(-?[\d.]+)/m', (string)file_get_contents($confPath), $m, PREG_SET_ORDER)) {
            foreach ($m as $kv) $conf[$kv[1]] = (float)$kv[2];
        }
        if (isset($conf['LATITUDE'], $conf['LONGITUDE']) && $hours <= 24 * 31) {
            $days = (int)ceil($hours / 24) + 1;
            for ($i = $days; $i >= -1; $i--) {
                $noon = strtotime(gmdate('Y-m-d', $now - $i * 86400) . ' 12:00:00 UTC') - $off;
                $info = date_sun_info($noon, $conf['LATITUDE'], $conf['LONGITUDE']);
                if (!is_int($info['sunrise']) || !is_int($info['sunset'])) continue;
                $sun[] = [$info['sunrise'] + $off, $info['sunset'] + $off];
            }
        }
        echo json_encode(['hours' => $hours, 'gap' => $VISIT_GAP, 'now' => $now,
                          'species' => $species, 'visits' => $visits, 'sun' => $sun,
                          'as_of' => date('c')]);
        break;
    }

    case 'timeseries': {
        // Aggregated time-bucketed counts for the stats charts.
        //   daily   - last $days days, detections + unique species per day
        //   by_hour - detections grouped by hour of day, last 30 days
        // The frontend backfills missing dates with zero - sparse data days
        // are otherwise dropped by the GROUP BY.
        $days = max(1, min(90, (int)($_GET['days'] ?? 30)));
        $daily = rows($db,
          "SELECT Date AS date, COUNT(*) AS detections, COUNT(DISTINCT Sci_Name) AS species "
        . "FROM detections "
        . "WHERE Date >= DATE('now','localtime','-".($days - 1)." day') "
        . "GROUP BY Date ORDER BY Date"
        );
        $by_hour = rows($db,
          "SELECT CAST(strftime('%H', Time) AS INT) AS hour, COUNT(*) AS detections "
        . "FROM detections "
        . "WHERE Date >= DATE('now','localtime','-30 day') "
        . "GROUP BY hour ORDER BY hour"
        );
        echo json_encode([
            'days'    => $days,
            'daily'   => $daily,
            'by_hour' => $by_hour,
            'as_of'   => date('c'),
        ]);
        break;
    }

    case 'firstseen': {
        // Most recent additions to the life list - first detection per
        // species, sorted by first_seen DESC. Powers the "First Detections"
        // section on the stats view.
        $limit = max(1, min(50, (int)($_GET['limit'] ?? 10)));
        $rs = rows($db,
          "SELECT Sci_Name AS sci, Com_Name AS com, MIN(Date||' '||Time) AS first_seen, "
        . "       COUNT(*) AS total "
        . "FROM detections GROUP BY Sci_Name ORDER BY first_seen DESC LIMIT :lim",
          [':lim' => $limit]
        );
        echo json_encode(['species' => $rs, 'as_of' => date('c')]);
        break;
    }

    default:
        http_response_code(404);
        echo json_encode(['error' => 'unknown action']);
}
