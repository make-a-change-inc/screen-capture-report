use AppleScript version "2.4" -- Yosemite (10.10) or later
use scripting additions

property pythonPid : 0
property projectRootPosix : ""

on run
	-- Initial setup and path calculation
    tell application "System Events"
        set appPath to path to me
        set projectRoot to path of container of appPath
    end tell
    set projectRootPosix to POSIX path of projectRoot
	
	my checkAndStart()
end run

on checkAndStart()
    set envFile to projectRootPosix & ".env"
    set envExampleFile to projectRootPosix & ".env.example"
    
    -- Check if pythonPid is actually running
    if pythonPid is not 0 then
        if not my isProcessRunning(pythonPid) then
            set pythonPid to 0
        end if
    end if
    
    if pythonPid is not 0 then
         -- Already running (and verified), show settings
         my showSettingsDialog()
         return
    end if
    
    tell application "System Events"
        if not (exists file envFile) then
            my startOnboarding(envExampleFile, envFile)
        end if
    end tell
    
    my launchPython()
end checkAndStart

on isProcessRunning(pid)
    try
        do shell script "ps -p " & pid
        return true
    on error
        return false
    end try
end isProcessRunning

on launchPython()
    if pythonPid is not 0 then return
    
    set venvPython to projectRootPosix & "venv/bin/python"
    
    set cdCommand to "cd " & quoted form of projectRootPosix
    set runCommand to quoted form of venvPython & " -m src.main"
    
    set fullCmd to cdCommand & " && " & runCommand & " > /dev/null 2>&1 & echo $!"
    
    try
        set pythonPid to (do shell script fullCmd) as integer
    on error errMsg
        display dialog "Error starting python process: " & errMsg buttons {"OK"} default button "OK" with icon stop
    end try
end launchPython

on quit
    if pythonPid is not 0 then
        try
            do shell script "kill " & pythonPid
        end try
        set pythonPid to 0
    end if
    continue quit
end quit

on reopen
    my checkAndStart()
end reopen


on showSettingsDialog()
    set envFile to projectRootPosix & ".env"
    
    tell me to activate
    
    -- Buttons logic: 
    -- "Hide": Just close dialog, keep running.
    -- "Open Log": Open the log file.
    -- "Quit App": Kill python and exit applet.
    
    display dialog "Screen Capture Report is running." & return & "PID: " & pythonPid buttons {"Open Log", "Quit App", "Hide"} default button "Hide" cancel button "Hide" with icon note
    
    set btn to button returned of result
    
    if btn is "Quit App" then
        quit
    else if btn is "Open Log" then
        my openLogFile()
        -- Recursively show dialog again so user can still quit or hide
        -- my showSettingsDialog() 
        -- Actually, usually opening log switches focus, so maybe just exit dialog (Hide) logic automatically.
    end if
end showSettingsDialog

on openLogFile()
     set logFile to projectRootPosix & "app.log"
     try
        do shell script "open " & quoted form of logFile
     end try
end openLogFile

on resetSettings(envFile)
    -- Deprecated in this view for simplicity, or can be added back if needed.
    -- For now focusing on Quit loop fix.
    display dialog "Are you sure you want to delete .env and reset settings? The app will quit." buttons {"Cancel", "Reset & Quit"} default button "Reset & Quit" with icon caution
    if button returned of result is "Reset & Quit" then
        try
            do shell script "rm " & quoted form of envFile
            quit
        on error errMsg
            display dialog "Error deleting .env: " & errMsg buttons {"OK"} default button "OK"
        end try
    end if
end resetSettings

on startOnboarding(envExamplePath, envPath)
	display dialog "Welcome to Screen Capture Report!" & return & return & "It looks like this is your first run. Let's set up your environment." buttons {"Start Setup", "Cancel"} default button "Start Setup" with icon note
	
	if button returned of result is "Cancel" then error number -128
	
	-- Gemini API Key
	set geminiKey to ""
	repeat
		display dialog "Enter your Google Gemini API Key:" default answer "" buttons {"OK"} default button "OK" with icon note with hidden answer
		set geminiKey to text returned of result
		if geminiKey is not "" then exit repeat
	end repeat
	
	-- Email User
    set emailUser to ""
	display dialog "Enter your email address (Gmail) for sending reports:" default answer "example@gmail.com" buttons {"OK", "Skip"} default button "OK" with icon note
    if button returned of result is "OK" then
        set emailUser to text returned of result
    end if
	
    -- Email App Password
    set emailPass to ""
    if emailUser is not "" then
        display dialog "Enter your Gmail App Password:" & return & "(https://support.google.com/mail/answer/185833?hl=ja)" default answer "" buttons {"OK", "Skip"} default button "OK" with icon note with hidden answer
        if button returned of result is "OK" then
            set emailPass to text returned of result
        end if
    end if
    
    set envContent to ""
    set envContent to envContent & "GEMINI_API_KEY=" & geminiKey & linefeed
    set envContent to envContent & "ANALYSIS_MODEL_NAME=gemini-2.5-flash" & linefeed
    set envContent to envContent & "NANOBANANA_API_URL=https://generativelanguage.googleapis.com/v1beta/models/nano-banana-pro-preview:generateContent" & linefeed
    set envContent to envContent & "NANOBANANA_MODEL_NAME=nano-banana-pro-preview" & linefeed
    
    if emailUser is not "" then
        set envContent to envContent & "SMTP_SERVER=smtp.gmail.com" & linefeed
        set envContent to envContent & "SMTP_PORT=587" & linefeed
        set envContent to envContent & "SMTP_USER=" & emailUser & linefeed
        set envContent to envContent & "SMTP_PASSWORD=" & emailPass & linefeed
        set envContent to envContent & "EMAIL_FROM=" & emailUser & linefeed
        set envContent to envContent & "EMAIL_TO=" & emailUser & linefeed
    end if
    
    try
        do shell script "echo " & quoted form of envContent & " > " & quoted form of envPath
        
        display notification "Configuration saved to .env" with title "Setup Complete"
        delay 1 
    on error errMsg
        display dialog "Failed to write .env file: " & errMsg buttons {"OK"} default button "OK" with icon stop
        error number -128
    end try
    
end startOnboarding
