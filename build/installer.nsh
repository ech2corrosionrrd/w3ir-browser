; Реєстрація W3IR Browser як браузера в Windows (з'являється в «Програми за замовчуванням»).
!macro customInstall
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\W3IRBrowser" "" "W3IR Browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\W3IRBrowser\DefaultIcon" "" "$INSTDIR\W3IR Browser.exe,0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\W3IRBrowser\shell\open\command" "" '"$INSTDIR\W3IR Browser.exe"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\W3IRBrowser\Capabilities" "ApplicationName" "W3IR Browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\W3IRBrowser\Capabilities" "ApplicationDescription" "W3IR Browser — швидкий приватний браузер"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\W3IRBrowser\Capabilities" "ApplicationIcon" "$INSTDIR\W3IR Browser.exe,0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\W3IRBrowser\Capabilities\URLAssociations" "http" "W3IRBrowserURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\W3IRBrowser\Capabilities\URLAssociations" "https" "W3IRBrowserURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\W3IRBrowser\Capabilities\StartMenu" "StartMenuInternet" "W3IRBrowser"
  WriteRegStr HKCU "Software\RegisteredApplications" "W3IRBrowser" "Software\Clients\StartMenuInternet\W3IRBrowser\Capabilities"
  WriteRegStr HKCU "Software\Classes\W3IRBrowserURL" "" "W3IR Browser URL"
  WriteRegStr HKCU "Software\Classes\W3IRBrowserURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\W3IRBrowserURL\DefaultIcon" "" "$INSTDIR\W3IR Browser.exe,0"
  WriteRegStr HKCU "Software\Classes\W3IRBrowserURL\shell\open\command" "" '"$INSTDIR\W3IR Browser.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\W3IRBrowser"
  DeleteRegValue HKCU "Software\RegisteredApplications" "W3IRBrowser"
  DeleteRegKey HKCU "Software\Classes\W3IRBrowserURL"
!macroend
