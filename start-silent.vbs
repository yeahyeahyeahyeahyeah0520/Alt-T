Option Explicit

Dim fso, rootDir, electronExe, mainBundle, shell
Set fso = CreateObject("Scripting.FileSystemObject")
rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = rootDir & "\node_modules\electron\dist\electron.exe"
mainBundle = rootDir & "\out\main\index.js"

If Not fso.FileExists(electronExe) Then
    MsgBox "Electron binary not found:" & vbCrLf & electronExe & vbCrLf & vbCrLf & "Please run: npm install", vbExclamation, "Alt-T"
    WScript.Quit 1
End If

If Not fso.FileExists(mainBundle) Then
    MsgBox "Build output not found:" & vbCrLf & mainBundle & vbCrLf & vbCrLf & "Please run: npm run build", vbExclamation, "Alt-T"
    WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")
On Error Resume Next
shell.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
shell.Environment("PROCESS").Remove "FP_SMOKE"
On Error GoTo 0
shell.CurrentDirectory = rootDir
shell.Run """" & electronExe & """ .", 0, False
