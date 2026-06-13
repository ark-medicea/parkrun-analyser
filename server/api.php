<?php
/**
 * #NoMasti ParkRun Dashboard API
 * 
 * Lightweight PHP API serving the ParkRun dashboard frontend.
 * All endpoints are GET requests with query parameters.
 * Database: SQLite3 (readonly)
 * 
 * Endpoints:
 *   ?dashboard=1    — Home page payload (athletes, this week, all results)
 *   ?athlete={id}   — Single athlete detail + full result history
 *   ?athletes=1     — Athletes management list
 */

declare(strict_types=1);

// ─── Headers ────────────────────────────────────────────────────────────────

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: public, max-age=60');

// Handle CORS preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Only GET allowed
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    respond(405, ['error' => 'Method not allowed']);
}

// ─── Database ───────────────────────────────────────────────────────────────

$dbPath = __DIR__ . '/parkrun.db';

if (!file_exists($dbPath)) {
    respond(500, ['error' => 'Database not found']);
}

try {
    $db = new SQLite3($dbPath, SQLITE3_OPEN_READONLY);
    $db->busyTimeout(5000);
    $db->exec('PRAGMA journal_mode=WAL');
} catch (Exception $e) {
    respond(500, ['error' => 'Database connection failed']);
}

// ─── Routing ────────────────────────────────────────────────────────────────

if (isset($_GET['lastUpdated'])) {
    handleLastUpdated($dbPath);
} elseif (isset($_GET['dashboard'])) {
    handleDashboard($db);
} elseif (isset($_GET['athlete'])) {
    handleAthlete($db, $_GET['athlete']);
} elseif (isset($_GET['athletes'])) {
    handleAthletesList($db);
} else {
    respond(400, ['error' => 'No valid endpoint specified. Use ?dashboard=1, ?athlete={id}, or ?athletes=1']);
}

$db->close();

// ─── Endpoint Handlers ─────────────────────────────────────────────────────

/**
 * Last updated endpoint — returns the DB file's last modification time.
 */
function handleLastUpdated(string $dbPath): void
{
    $mtime = filemtime($dbPath);
    respond(200, [
        'lastUpdated' => $mtime ? date('c', $mtime) : null,
        'lastUpdatedUnix' => $mtime ?: null,
    ]);
}


/**
 * Dashboard endpoint — returns everything the home page needs in one shot.
 * Includes active athletes, this week's results, and all historical 5k results.
 */
function handleDashboard(SQLite3 $db): void
{
    // Find the latest result date (our "this week")
    $latestDate = queryValue($db, "SELECT MAX(date) FROM results WHERE is_junior = 0");

    if (!$latestDate) {
        respond(200, [
            'latestDate' => null,
            'athletes'   => [],
            'thisWeek'   => [],
            'thisWeekJunior' => [],
            'allResults' => [],
        ]);
    }

    // Active athletes with computed age grade stats (5k only)
    $athletes = queryAll($db, "
        SELECT
            a.id, a.name, a.gender, a.age_group, a.home_event, a.badge,
            a.total_5k, a.total_junior, a.volunteer_count, a.prev_volunteer_count,
            ROUND(MAX(r.age_grade), 2) AS best_ag,
            ROUND(AVG(r.age_grade), 2) AS avg_ag
        FROM athletes a
        LEFT JOIN results r ON r.athlete_id = a.id AND r.is_junior = 0
        WHERE a.active = 1
        GROUP BY a.id
        ORDER BY a.total_5k DESC
    ");

    // This week's 5k results joined with athlete info
    $thisWeek = queryAll($db, "
        SELECT
            r.athlete_id, a.name, a.badge, a.home_event,
            r.event, r.time, r.time_seconds, r.position,
            r.age_grade, r.is_pb
        FROM results r
        JOIN athletes a ON a.id = r.athlete_id
        WHERE r.date = :date AND r.is_junior = 0
        ORDER BY r.time_seconds ASC
    ", [':date' => $latestDate]);

    // This week's junior results
    $latestJuniorDate = queryValue($db, "SELECT MAX(date) FROM results WHERE is_junior = 1");
    $thisWeekJunior = [];

    if ($latestJuniorDate) {
        $thisWeekJunior = queryAll($db, "
            SELECT
                r.athlete_id, a.name,
                r.event, r.time, r.time_seconds, r.position
            FROM results r
            JOIN athletes a ON a.id = r.athlete_id
            WHERE r.date = :date AND r.is_junior = 1
            ORDER BY r.time_seconds ASC
        ", [':date' => $latestJuniorDate]);
    }

    // All 5k results for active athletes (for league tables, streaks, highlights)
    $allResults = queryAll($db, "
        SELECT
            r.athlete_id, r.date, r.event, r.time_seconds, r.age_grade, r.is_pb
        FROM results r
        JOIN athletes a ON a.id = r.athlete_id
        WHERE a.active = 1 AND r.is_junior = 0
        ORDER BY r.date ASC
    ");

    respond(200, [
        'latestDate'      => $latestDate,
        'athletes'        => $athletes,
        'thisWeek'        => $thisWeek,
        'thisWeekJunior'  => $thisWeekJunior,
        'allResults'      => $allResults,
    ]);
}

/**
 * Single athlete endpoint — full profile, all results, computed stats.
 */
function handleAthlete(SQLite3 $db, string $rawId): void
{
    // Sanitise: athlete IDs are alphanumeric (ParkRun IDs like "A123456")
    $id = preg_replace('/[^A-Za-z0-9]/', '', $rawId);

    if ($id === '') {
        respond(400, ['error' => 'Invalid athlete ID']);
    }

    // Fetch athlete record
    $athlete = queryRow($db, "
        SELECT id, name, gender, age_group, home_event, badge,
               total_5k, total_junior, volunteer_count, pb_5k, pb_5k_seconds
        FROM athletes
        WHERE id = :id
    ", [':id' => $id]);

    if (!$athlete) {
        respond(404, ['error' => 'Athlete not found']);
    }

    // All results for this athlete
    $results = queryAll($db, "
        SELECT date, event, time, time_seconds, position, age_grade, is_pb, is_junior
        FROM results
        WHERE athlete_id = :id
        ORDER BY date ASC
    ", [':id' => $id]);

    // Compute all-time stats from 5k results
    $stats5k = queryRow($db, "
        SELECT
            ROUND(MAX(age_grade), 2)  AS best_ag,
            ROUND(AVG(age_grade), 2)  AS avg_ag,
            MAX(time_seconds)         AS worst_time,
            ROUND(AVG(time_seconds))  AS avg_time,
            COUNT(*)                  AS total_results_5k
        FROM results
        WHERE athlete_id = :id AND is_junior = 0
    ", [':id' => $id]);

    $juniorCount = queryValue($db, "
        SELECT COUNT(*) FROM results WHERE athlete_id = :id AND is_junior = 1
    ", [':id' => $id]);

    $allTimeStats = [
        'best_ag'              => $stats5k['best_ag'] ?? null,
        'avg_ag'               => $stats5k['avg_ag'] ?? null,
        'worst_time'           => (int)($stats5k['worst_time'] ?? 0),
        'avg_time'             => (int)($stats5k['avg_time'] ?? 0),
        'total_results_5k'     => (int)($stats5k['total_results_5k'] ?? 0),
        'total_results_junior' => (int)$juniorCount,
    ];

    respond(200, [
        'athlete'      => $athlete,
        'results'      => $results,
        'allTimeStats' => $allTimeStats,
    ]);
}

/**
 * Athletes management list — all athletes with last run date.
 */
function handleAthletesList(SQLite3 $db): void
{
    $athletes = queryAll($db, "
        SELECT
            a.id, a.name, a.age_group, a.badge, a.total_5k,
            a.pb_5k, a.volunteer_count,
            MAX(r.date) AS last_run
        FROM athletes a
        LEFT JOIN results r ON r.athlete_id = a.id
        GROUP BY a.id
        ORDER BY a.name ASC
    ");

    respond(200, [
        'athletes' => $athletes,
    ]);
}

// ─── Database Helpers ───────────────────────────────────────────────────────

/**
 * Execute a query and return all rows as associative arrays.
 */
function queryAll(SQLite3 $db, string $sql, array $params = []): array
{
    $stmt = $db->prepare($sql);
    if (!$stmt) {
        respond(500, ['error' => 'Query preparation failed']);
    }

    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
    }

    $result = $stmt->execute();
    if (!$result) {
        respond(500, ['error' => 'Query execution failed']);
    }

    $rows = [];
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        // Cast numeric fields so JSON encodes them properly
        $rows[] = castNumericFields($row);
    }

    $stmt->close();
    return $rows;
}

/**
 * Execute a query and return a single row.
 */
function queryRow(SQLite3 $db, string $sql, array $params = []): ?array
{
    $rows = queryAll($db, $sql, $params);
    return $rows[0] ?? null;
}

/**
 * Execute a query and return a single scalar value.
 */
function queryValue(SQLite3 $db, string $sql, array $params = []): mixed
{
    $stmt = $db->prepare($sql);
    if (!$stmt) {
        respond(500, ['error' => 'Query preparation failed']);
    }

    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
    }

    $result = $stmt->execute();
    if (!$result) {
        return null;
    }

    $row = $result->fetchArray(SQLITE3_NUM);
    $stmt->close();

    return $row ? $row[0] : null;
}

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Cast fields that should be numeric in JSON output.
 * SQLite3 returns everything as strings; we fix that here.
 */
function castNumericFields(array $row): array
{
    $intFields = [
        'total_5k', 'total_junior', 'volunteer_count', 'prev_volunteer_count',
        'time_seconds', 'position', 'is_pb', 'is_junior', 'active',
        'pb_5k_seconds', 'worst_time', 'avg_time',
        'total_results_5k', 'total_results_junior',
    ];
    $floatFields = ['age_grade', 'best_ag', 'avg_ag'];

    foreach ($row as $key => &$value) {
        if ($value === null) continue;

        if (in_array($key, $intFields, true)) {
            $value = (int)$value;
        } elseif (in_array($key, $floatFields, true)) {
            $value = (float)$value;
        }
    }

    return $row;
}

/**
 * Send a JSON response and exit.
 */
function respond(int $code, array $data): never
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
