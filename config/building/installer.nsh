; SGC Songs installer additions (electron-builder NSIS include)
; Opening a newer SGC Songs installer replaces the installed version: same app id, same install folder,
; and electron-builder runs the old version's uninstaller (settings and the data folder are kept).
; These cover what it can't on its own.

!macro customInit
  ; close the running app first - including a copy from before the rename, which the built-in
  ; "is it running" check doesn't recognise (its files would stay locked and the update half-done)
  nsExec::Exec 'taskkill /F /T /IM "SGC-Songs.exe"'
  nsExec::Exec 'taskkill /F /T /IM "FreeShow-Remastered.exe"'
  Sleep 1000
!macroend

!macro customInstall
  ; shortcuts left over from the "FreeShow (Remastered)" name
  Delete "$DESKTOP\FreeShow (Remastered).lnk"
  Delete "$SMPROGRAMS\FreeShow (Remastered).lnk"
!macroend
