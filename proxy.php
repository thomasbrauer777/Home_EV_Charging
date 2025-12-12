<?php
// proxy.php
// Erlaubt der Webseite, Daten von anderen Geräten im Netzwerk zu holen
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json");

// IP Adresse aus der URL holen
$ip = $_GET['ip'];

// Einfache Sicherheitsprüfung: Nur lokale IPs erlauben
if (strpos($ip, '192.168.') === false && strpos($ip, '10.') === false && strpos($ip, '172.') === false) {
    die('{"error": "Nur lokale IPs erlaubt"}');
}

// Daten vom myStrom holen und an die Webseite weitergeben
$json = file_get_contents("http://" . $ip . "/report");

if ($json === FALSE) {
    echo '{"error": "Konnte myStrom nicht erreichen"}';
} else {
    echo $json;
}
?>
