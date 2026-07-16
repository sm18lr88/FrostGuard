param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class RestartManagerLockOwners
{
    const int ERROR_MORE_DATA = 234;
    const int CCH_RM_SESSION_KEY = 32;

    [StructLayout(LayoutKind.Sequential)]
    public struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS
    {
        public int ProcessId;
        public FILETIME ProcessStartTime;
    }

    public enum RM_APP_TYPE
    {
        Unknown = 0,
        MainWindow = 1,
        OtherWindow = 2,
        Service = 3,
        Explorer = 4,
        Console = 5,
        Critical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string ServiceShortName;
        public RM_APP_TYPE ApplicationType;
        public uint AppStatus;
        public uint TerminalSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool Restartable;
    }

    public sealed class Owner
    {
        public int Pid { get; set; }
        public long CreationFileTime { get; set; }
        public string AppName { get; set; }
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint sessionHandle, int flags, StringBuilder sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(
        uint sessionHandle,
        uint fileCount,
        string[] fileNames,
        uint applicationCount,
        RM_UNIQUE_PROCESS[] applications,
        uint serviceCount,
        string[] serviceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(
        uint sessionHandle,
        out uint needed,
        ref uint count,
        [In, Out] RM_PROCESS_INFO[] affectedApplications,
        ref uint rebootReasons);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint sessionHandle);

    public static Owner[] GetOwners(string path)
    {
        uint handle;
        var key = new StringBuilder(CCH_RM_SESSION_KEY + 1);
        var result = RmStartSession(out handle, 0, key);
        if (result != 0) throw new InvalidOperationException("RmStartSession failed: " + result);

        try
        {
            result = RmRegisterResources(handle, 1, new[] { path }, 0, null, 0, null);
            if (result != 0) throw new InvalidOperationException("RmRegisterResources failed: " + result);

            uint needed;
            uint count = 0;
            uint rebootReasons = 0;
            result = RmGetList(handle, out needed, ref count, null, ref rebootReasons);
            if (result == 0) return Array.Empty<Owner>();
            if (result != ERROR_MORE_DATA) throw new InvalidOperationException("RmGetList failed: " + result);

            var processes = new RM_PROCESS_INFO[needed];
            count = needed;
            result = RmGetList(handle, out needed, ref count, processes, ref rebootReasons);
            if (result != 0) throw new InvalidOperationException("RmGetList failed: " + result);

            var owners = new List<Owner>();
            for (var index = 0; index < count; index++)
            {
                var process = processes[index].Process;
                var fileTime = ((long)process.ProcessStartTime.High << 32) | process.ProcessStartTime.Low;
                owners.Add(new Owner
                {
                    Pid = process.ProcessId,
                    CreationFileTime = fileTime,
                    AppName = processes[index].AppName
                });
            }
            return owners.ToArray();
        }
        finally
        {
            RmEndSession(handle);
        }
    }
}
'@

Add-Type -TypeDefinition $source
[RestartManagerLockOwners]::GetOwners($Path) | ConvertTo-Json -Compress
