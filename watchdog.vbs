Option Explicit

Dim fso, rootDir, electronExe, mainBundle, shell, appDataDir
Dim backoffMs, maxBackoffMs, stableThresholdSec, startedAt, exitCode, elapsedSec

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

appDataDir = shell.ExpandEnvironmentStrings("%APPDATA%")
backoffMs = 2000
maxBackoffMs = 60000
stableThresholdSec = 30

Function HasCleanExitFlag(fsObj, baseAppData)
    Dim flagPath
    flagPath = baseAppData & "\Alt-T\clean-exit.flag"
    HasCleanExitFlag = fsObj.FileExists(flagPath)
End Function

Do
    If Not fso.FileExists(electronExe) Or Not fso.FileExists(mainBundle) Then
        WScript.Quit 1
    End If

    startedAt = Now
    exitCode = shell.Run("""" & electronExe & """ .", 0, True)

    If exitCode = 0 Then
        WScript.Quit 0
    End If

    If HasCleanExitFlag(fso, appDataDir) Then
        WScript.Quit 0
    End If

    elapsedSec = DateDiff("s", startedAt, Now)
    If elapsedSec >= stableThresholdSec Then
        backoffMs = 2000
    End If

    WScript.Sleep backoffMs
    If backoffMs < maxBackoffMs Then
        backoffMs = backoffMs * 2
        If backoffMs > maxBackoffMs Then
            backoffMs = maxBackoffMs
        End If
    End If
Loop
