Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "c:\Users\mouph\Desktop\SKKU\Untitled\Paper-reading-assistant"
WshShell.Run "cmd /c npm start", 0, False
