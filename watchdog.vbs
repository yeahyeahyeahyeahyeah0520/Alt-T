Option Explicit

Dim fso, rootDir, electronExe, mainBundle, shell, appDataDir
Dim backoffMs, maxBackoffMs, stableThresholdSec, startedAt, exitCode, elapsedSec

Set fso = CreateObject("Scripting.FileSystemObject")
rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = rootDir & "\node_modules\electron\dist\electron.exe"
mainBundle = rootDir & "\out\main\index.js"

If Not fso.FileExists(electronExe) Then
    MsgBox "Electron binary not found:" & vbCrLf & electronExe & vbCrLf & vbCrLf & "Please run: npm install", vbExclamation, "FlashPrompt"
    WScript.Quit 1
End If

If Not fso.FileExists(mainBundle) Then
    MsgBox "Build output not found:" & vbCrLf & mainBundle & vbCrLf & vbCrLf & "Please run: npm run build", vbExclamation, "FlashPrompt"
    WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")
On Error Resume Next
shell.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
shell.Environment("PROCESS").Remove "TTL_SMOKE"
shell.Environment("PROCESS").Remove "FP_SMOKE"
On Error GoTo 0
shell.CurrentDirectory = rootDir

appDataDir = shell.ExpandEnvironmentStrings("%APPDATA%")
backoffMs = 2000
maxBackoffMs = 60000
stableThresholdSec = 30

Function HasCleanExitFlag(fsObj, baseAppData)
    Dim candidates(3)
    Dim i
    candidates(0) = baseAppData & "\FlashPrompt\clean-exit.flag"
    candidates(1) = baseAppData & "\TTime Lite\clean-exit.flag"
    candidates(2) = baseAppData & "\ttime-lite\clean-exit.flag"
    candidates(3) = baseAppData & "\TTime Lite\intentional-quit.flag"
    HasCleanExitFlag = False
    For i = 0 To UBound(candidates)
        If fsObj.FileExists(candidates(i)) Then
            HasCleanExitFlag = True
            Exit Function
        End If
    Next
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
