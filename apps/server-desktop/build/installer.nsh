; Playpex Media Server: additions to electron-builder's NSIS script (plan §8.2).
; Per-user install, no admin rights, no firewall rules (Windows asks itself the
; first time the server listens on the LAN; the tray has "Allow through firewall…").

; Uninstall (not an update): remove the start-at-login entry, and ask whether
; to delete the server's data, which lives outside the install folder
; (apps/server/lib/paths.js). A download folder chosen in the settings stays.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Playpex Media Server"
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete Playpex's data?$\r$\n$\r$\nSettings, the database (profiles, watch lists, paired devices), logs and the default downloads folder:$\r$\n$APPDATA\Playpex$\r$\n$LOCALAPPDATA\Playpex$\r$\n$\r$\nChoose No to keep them for a later install." IDNO playpexKeepData
        RMDir /r "$APPDATA\Playpex"
        RMDir /r "$LOCALAPPDATA\Playpex"
      playpexKeepData:
    ${endIf}
  ${endIf}
!macroend
