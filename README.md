# Writy

Kleine Schreib-App im 8-Bit-Look – mit Begleiter Klecks.

* Jedes Dokument wird als eigene `.md`-Datei gespeichert (Standard: `Dokumente\Writy`, änderbar unter OPTIONEN).
* Die erste Zeile ist Titel und Dateiname.
* Listen mit `- ` und `1. `, Fokusmodus, Tagesziel, drei Looks (Tag, Nacht, Matrix).

## Installieren

Unter **Releases** die Datei `Writy_…_x64-setup.exe` herunterladen und starten.
Windows meldet beim ersten Mal evtl. „Der Computer wurde durch Windows geschützt“ –
dann auf **Weitere Informationen → Trotzdem ausführen** klicken.

## Wie es gebaut wird

`src/` ist die Oberfläche (HTML), `src-tauri/` die Windows-Hülle (Tauri).
Bei jedem Push auf `main` baut GitHub Actions automatisch einen neuen Installer.
Für eine neue Version die Versionsnummer in `src-tauri/tauri.conf.json` erhöhen.
