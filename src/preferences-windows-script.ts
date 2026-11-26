export const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class PredictionsPreferences {
    const uint ReadControl = 0x20000, Delete = 0x10000, WriteDac = 0x40000, WriteOwner = 0x80000;
    const uint ReadData = 1, WriteData = 2, AppendData = 4, WriteEa = 0x10, DeleteChild = 0x40, ReadAttr = 0x80, WriteAttr = 0x100;
    const uint Security = 0x77, ProtectedDacl = 0x80000004;
    const uint DirectoryFlag = 0x10, Reparse = 0x400, ReadOnly = 1;
    const uint NoFollow = 0x00200000, DirectoryHandle = 0x02000000, ShareRead = 1, ShareWrite = 2, ShareDelete = 4;
    const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, CreateNew = 1, OpenExisting = 3;
    const uint Mutate = Delete | WriteDac | WriteOwner | WriteEa | WriteAttr;
    const int Limit = 65536;

    [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] struct FileInfoByHandle {
        public uint Attributes, CreatedLow, CreatedHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IdHigh, IdLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct GenericMapping { public uint Read, Write, Execute, All; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr attrs, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern bool CreateDirectoryW(string path, IntPtr attrs);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfoByHandle info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern bool GetVolumeInformationW(string root, IntPtr name, uint nameSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder fileSystem, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(SafeFileHandle file, byte[] bytes, int length, out int written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle file);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle file, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle file, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateToken(IntPtr token, int level, out SafeFileHandle duplicate);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AccessCheck(byte[] descriptor, SafeFileHandle token, uint desired, ref GenericMapping mapping, IntPtr privileges, ref uint size, out uint granted, [MarshalAs(UnmanagedType.Bool)] out bool allowed);

    static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
    static readonly SecurityIdentifier AdminSid = new SecurityIdentifier("S-1-5-32-544");
    static readonly SecurityIdentifier InstallerSid = new SecurityIdentifier("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
    static Win32Exception LastError() { return new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Require(bool ok) { if (!ok) throw new IOException(); }

    public sealed class Snapshot {
        public string source { get; set; }
        public string state { get; set; }
        public bool writable { get; set; }
        public string expected { get; set; }
        public string bytes { get; set; }
    }
    public sealed class Reply {
        public string kind { get; set; }
        public Snapshot snapshot { get; set; }
    }
    static Reply Result(string kind, Snapshot snapshot = null) { return new Reply { kind = kind, snapshot = snapshot }; }

    sealed class Item : IDisposable {
        public string Path;
        public SafeFileHandle Handle;
        public FileInfoByHandle Info;
        public byte[] SecurityBytes;
        public RawSecurityDescriptor Descriptor;
        public void Dispose() { Handle.Dispose(); }
    }

    static Item Open(string path, bool directory, bool allowMissing, bool expectReparse = false) {
        uint read = ReadControl | ReadAttr | ReadData;
        // Listing access makes a directory handle participate in delete sharing.
        var handle = CreateFileW(path, read, ShareRead | ShareWrite | (directory ? 0 : ShareDelete), IntPtr.Zero, OpenExisting, NoFollow | DirectoryHandle, IntPtr.Zero);
        if (handle.IsInvalid) {
            var error = LastError();
            handle.Dispose();
            if (allowMissing && error.NativeErrorCode == 2) return null;
            throw error;
        }
        try {
            var item = new Item { Path = path, Handle = handle };
            Inspect(item);
            Require(expectReparse || (item.Info.Attributes & Reparse) == 0);
            Require(((item.Info.Attributes & DirectoryFlag) != 0) == directory);
            Require(directory || item.Info.Links == 1);
            return item;
        } catch {
            handle.Dispose();
            throw;
        }
    }

    static void Inspect(Item item) {
        if (!GetFileInformationByHandle(item.Handle, out item.Info)) throw LastError();
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(item.Handle, 1, Security, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try {
            var bytes = new byte[checked((int)GetSecurityDescriptorLength(descriptor))];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            item.SecurityBytes = bytes;
            item.Descriptor = new RawSecurityDescriptor(bytes, 0);
        } finally { LocalFree(descriptor); }
    }

    sealed class Session : IDisposable {
        readonly SecurityIdentifier user;
        readonly SafeFileHandle token;
        public Session() {
            using (var identity = WindowsIdentity.GetCurrent()) {
                user = identity.User;
                if (!DuplicateToken(identity.Token, 2, out token)) throw LastError();
            }
        }
        public void Dispose() { token.Dispose(); }

        bool Trusted(SecurityIdentifier sid, bool ancestor) {
            return sid == user || sid == SystemSid || sid == AdminSid || (ancestor && sid == InstallerSid);
        }

        static uint Expand(uint mask) {
            if ((mask & 0x10000000) != 0) mask |= 0x1f01ff;
            if ((mask & 0x40000000) != 0) mask |= 0x120116;
            if ((mask & 0x80000000) != 0) mask |= 0x120089;
            if ((mask & 0x20000000) != 0) mask |= 0x1200a0;
            return mask & 0x0fffffff;
        }

        void Safe(Item item, bool ancestor, bool directory, bool privateFile = false) {
            var sd = item.Descriptor;
            Require(ancestor ? Trusted(sd.Owner, true) : sd.Owner == user);
            Require(sd.DiscretionaryAcl != null && (sd.ControlFlags & ControlFlags.DiscretionaryAclPresent) != 0);
            // Replacement must not drop a file's integrity label or central access policy.
            if (!directory) Require(sd.SystemAcl == null || sd.SystemAcl.Count == 0);
            uint forbidden = Mutate | (directory ? DeleteChild : 0) | (ancestor ? 0 : WriteData | AppendData);
            foreach (var entry in sd.DiscretionaryAcl) {
                var ace = entry as CommonAce;
                Require(ace != null && !ace.IsCallback && (ace.AceType == AceType.AccessAllowed || ace.AceType == AceType.AccessDenied));
                if ((ace.AceFlags & AceFlags.InheritOnly) != 0 || ace.AceType != AceType.AccessAllowed || Trusted(ace.SecurityIdentifier, ancestor)) continue;
                Require(!privateFile && (Expand((uint)ace.AccessMask) & forbidden) == 0);
            }
        }

        bool Can(Item item, uint desired) {
            var mapping = new GenericMapping { Read = 0x120089, Write = 0x120116, Execute = 0x1200a0, All = 0x1f01ff };
            uint size = 1024, granted;
            bool allowed;
            var privileges = Marshal.AllocHGlobal((int)size);
            try {
                if (!AccessCheck(item.SecurityBytes, token, desired, ref mapping, privileges, ref size, out granted, out allowed)) throw LastError();
                return allowed;
            } finally { Marshal.FreeHGlobal(privileges); }
        }

        static string[] Components(string path) {
            Require(path.Length >= 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) && path[1] == ':' && (path[2] == '\\' || path[2] == '/'));
            var parts = path.Substring(3).Split('\\', '/');
            Require(parts.All(part => part.Length > 0 && part.IndexOfAny(new[] { '\0', ':', '*', '?', '<', '>', '"', '|' }) < 0 && !part.EndsWith(".") && !part.EndsWith(" ")));
            return parts;
        }

        sealed class Chain : IDisposable {
            public readonly List<Item> Items = new List<Item>();
            public string Physical;
            public int Next;
            public string[] Parts;
            public Item Parent { get { return Items[Items.Count - 1]; } }
            public bool DirectoryExists { get { return Next == Parts.Length - 1; } }
            public string FilePath { get { return Path.Combine(Physical, Parts[Parts.Length - 1]); } }
            public void Dispose() {
                for (int i = Items.Count - 1; i >= 0; i--) Items[i].Dispose();
            }
        }

        Chain Pin(string source, bool administrative) {
            var chain = new Chain { Parts = Components(source) };
            try {
                var drive = source.Substring(0, 2) + "\\";
                Require(GetDriveTypeW(drive) == 3);
                var root = Open(drive, true, false);
                chain.Items.Add(root);
                var name = new StringBuilder(128);
                var length = GetFinalPathNameByHandleW(root.Handle, name, (uint)name.Capacity, 1);
                Require(length > 0 && length < name.Capacity);
                var volume = name.ToString();
                Guid volumeId;
                Require(volume.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) && volume.EndsWith(@"}\") && volume.Length == 49 && Guid.TryParse(volume.Substring(11, 36), out volumeId));
                uint serial, maxComponent, flags;
                var fileSystem = new StringBuilder(32);
                Require(GetVolumeInformationW(volume, IntPtr.Zero, 0, out serial, out maxComponent, out flags, fileSystem, (uint)fileSystem.Capacity));
                Require(serial == root.Info.Volume && fileSystem.ToString() == "NTFS" && (flags & 8) != 0);
                Safe(root, true, true);
                chain.Physical = volume;
                while (!chain.DirectoryExists) {
                    var path = Path.Combine(chain.Physical, chain.Parts[chain.Next]);
                    var child = Open(path, true, true);
                    if (child == null) break;
                    chain.Items.Add(child);
                    chain.Physical = path;
                    chain.Next++;
                    Safe(child, administrative || !chain.DirectoryExists, true);
                }
                return chain;
            } catch { chain.Dispose(); throw; }
        }

        bool Managed(string[] paths) {
            if (paths == null || paths.Length == 0) return true;
            foreach (var source in paths) {
                try {
                    using (var chain = Pin(source, true)) {
                        if (!chain.DirectoryExists) continue;
                        // Any existing entry suppresses preferences; inability to inspect it does too.
                        using (var item = Open(chain.FilePath, true, true, true)) if (item != null) return true;
                    }
                } catch { return true; }
            }
            return false;
        }

        byte[] ReadFile(Item item) {
            using (var view = new SafeFileHandle(item.Handle.DangerousGetHandle(), false))
            using (var stream = new FileStream(view, FileAccess.Read, 4096, false)) {
                byte[] data = new byte[Limit + 1];
                int total = 0, n;
                while (total < data.Length && (n = stream.Read(data, total, data.Length - total)) != 0) total += n;
                Require(total <= Limit);
                Array.Resize(ref data, total);
                return data;
            }
        }

        static void AddItem(BinaryWriter writer, Item item) {
            writer.Write(item.Info.Volume); writer.Write(item.Info.IdHigh); writer.Write(item.Info.IdLow);
            writer.Write(item.Info.Attributes); writer.Write(item.Info.Links);
            writer.Write(item.SecurityBytes.Length); writer.Write(item.SecurityBytes);
        }

        Snapshot Read(Chain chain, string source) {
            using (var data = new MemoryStream())
            using (var stamp = new BinaryWriter(data, Encoding.UTF8))
            using (var file = chain.DirectoryExists ? Open(chain.FilePath, false, true) : null) {
                stamp.Write("windows-preferences-v1"); stamp.Write(source); stamp.Write(chain.Next);
                foreach (var item in chain.Items) {
                    Inspect(item);
                    Require((item.Info.Attributes & Reparse) == 0);
                    Safe(item, item != chain.Parent || !chain.DirectoryExists, true);
                    AddItem(stamp, item);
                }
                stamp.Write(file != null);
                bool writable = Can(chain.Parent, chain.DirectoryExists ? WriteData : AppendData);
                byte[] bytes = null;
                if (file != null) {
                    Safe(file, false, false);
                    bytes = ReadFile(file);
                    writable = writable && (file.Info.Attributes & ReadOnly) == 0 && Can(file, WriteData);
                    AddItem(stamp, file); stamp.Write(bytes.Length); stamp.Write(bytes);
                }
                stamp.Flush();
                using (var sha = SHA256.Create()) {
                    var expected = BitConverter.ToString(sha.ComputeHash(data.ToArray())).Replace("-", "").ToLowerInvariant();
                    return new Snapshot { source = source, state = "user", writable = writable, expected = expected, bytes = bytes == null ? null : Convert.ToBase64String(bytes) };
                }
            }
        }

        RawSecurityDescriptor Private(bool directory) {
            var flags = directory ? AceFlags.ContainerInherit | AceFlags.ObjectInherit : AceFlags.None;
            var acl = new RawAcl(GenericAcl.AclRevision, 3);
            foreach (var sid in new[] { user, SystemSid, AdminSid })
                acl.InsertAce(acl.Count, new CommonAce(flags, AceQualifier.AccessAllowed, 0x1f01ff, sid, false, null));
            return new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected, user, null, null, acl);
        }

        static T WithBytes<T>(byte[] bytes, Func<IntPtr, T> fn) {
            var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try { return fn(pin.AddrOfPinnedObject()); }
            finally { pin.Free(); }
        }

        static T WithAttributes<T>(RawSecurityDescriptor sd, Func<IntPtr, T> fn) {
            var bytes = new byte[sd.BinaryLength];
            sd.GetBinaryForm(bytes, 0);
            return WithBytes(bytes, descriptor => {
                var length = Marshal.SizeOf(typeof(Attributes));
                var attrs = Marshal.AllocHGlobal(length);
                try {
                    Marshal.StructureToPtr(new Attributes { Length = length, Descriptor = descriptor, Inherit = 0 }, attrs, false);
                    return fn(attrs);
                } finally { Marshal.FreeHGlobal(attrs); }
            });
        }

        void CreateMissing(Chain chain) {
            while (!chain.DirectoryExists) {
                var path = Path.Combine(chain.Physical, chain.Parts[chain.Next]);
                if (!WithAttributes(Private(true), attrs => CreateDirectoryW(path, attrs))) throw LastError();
                var child = Open(path, true, false);
                chain.Items.Add(child);
                chain.Physical = path;
                chain.Next++;
                Safe(child, !chain.DirectoryExists, true);
            }
        }

        static void Rename(SafeFileHandle file, string path) {
            var bytes = Encoding.Unicode.GetBytes(path);
            int root = IntPtr.Size, length = root * 2, start = length + 4;
            var info = new byte[start + bytes.Length + 2];
            info[0] = 1; // ReplaceIfExists; the name stays on the pinned local volume.
            Buffer.BlockCopy(BitConverter.GetBytes(bytes.Length), 0, info, length, 4);
            Buffer.BlockCopy(bytes, 0, info, start, bytes.Length);
            if (!WithBytes(info, p => SetFileInformationByHandle(file, 3, p, (uint)info.Length))) throw LastError();
        }

        static void Discard(SafeFileHandle file) {
            WithBytes(new byte[] { 1 }, p => SetFileInformationByHandle(file, 4, p, 1));
        }

        void NarrowAcl(SafeFileHandle file, RawAcl previous) {
            var privateAcl = new RawAcl(previous.Revision, previous.Count);
            foreach (CommonAce ace in previous) {
                if (ace.AceType == AceType.AccessAllowed && !Trusted(ace.SecurityIdentifier, false)) continue;
                var copy = (CommonAce)ace.Copy();
                copy.AceFlags &= ~AceFlags.Inherited;
                privateAcl.InsertAce(privateAcl.Count, copy);
            }
            var bytes = new byte[privateAcl.BinaryLength];
            privateAcl.GetBinaryForm(bytes, 0);
            var error = WithBytes(bytes, p => SetSecurityInfo(file, 1, ProtectedDacl, IntPtr.Zero, IntPtr.Zero, p, IntPtr.Zero));
            if (error != 0) throw new Win32Exception((int)error);
        }

        SafeFileHandle Stage(string directory, byte[] bytes, RawAcl activeAcl) {
            var path = Path.Combine(directory, ".predictions.tmp-" + Guid.NewGuid().ToString("N"));
            var file = WithAttributes(Private(false), attrs => CreateFileW(path, ReadControl | ReadAttr | WriteDac | Delete | GenericWrite, ShareRead, attrs, CreateNew, NoFollow, IntPtr.Zero));
            if (file.IsInvalid) { var error = LastError(); file.Dispose(); throw error; }
            try {
                var item = new Item { Path = path, Handle = file };
                Inspect(item);
                Require(item.Info.Links == 1 && (item.Info.Attributes & (Reparse | DirectoryFlag)) == 0);
                Safe(item, false, false, true);
                /* BEFORE_STAGE_WRITE */
                int written;
                if (!WriteFile(file, bytes, bytes.Length, out written, IntPtr.Zero)) throw LastError();
                Require(written == bytes.Length);
                if (activeAcl != null) NarrowAcl(file, activeAcl);
                if (!FlushFileBuffers(file)) throw LastError();
                return file;
            } catch { Discard(file); file.Dispose(); throw; }
        }

        static Snapshot Masked(string source, string state) {
            return new Snapshot { source = source, state = state, writable = false, expected = "", bytes = null };
        }

        public Reply Run(string op, string source, string[] administration, string expected, string content) {
            bool committed = false;
            try {
                if (Managed(administration)) return op == "read" ? Result("snapshot", Masked(source, "managed")) : Result("read_only");
                using (var chain = Pin(source, false)) {
                    var before = Read(chain, source);
                    if (op == "read") return Result("snapshot", before);
                    if (before.expected != expected) return Result("conflict");
                    if (!before.writable) return Result("read_only");
                    byte[] next = Convert.FromBase64String(content);
                    Require(next.Length <= Limit);
                    if (!chain.DirectoryExists) {
                        CreateMissing(chain);
                        before = Read(chain, source);
                        if (before.bytes != null) return Result("conflict");
                        if (!before.writable) return Result("read_only");
                    }
                    RawAcl activeAcl = null;
                    using (var active = Open(chain.FilePath, false, true)) {
                        if (active != null) {
                            Safe(active, false, false);
                            activeAcl = active.Descriptor.DiscretionaryAcl;
                        }
                    }
                    var path = chain.FilePath;
                    using (var stage = Stage(chain.Physical, next, activeAcl)) {
                        try {
                            if (Managed(administration) || Read(chain, source).expected != before.expected) return Result("conflict");
                            if (before.bytes != null) {
                                var backup = path + ".backup";
                                using (var existing = Open(backup, false, true)) if (existing != null) Safe(existing, false, false, true);
                                using (var copy = Stage(chain.Physical, Convert.FromBase64String(before.bytes), null)) {
                                    try { Rename(copy, backup); }
                                    catch { Discard(copy); throw; }
                                }
                            }
                            if (Managed(administration) || Read(chain, source).expected != before.expected) return Result("conflict");
                            /* BEFORE_ACTIVE_REPLACE */
                            Rename(stage, path);
                            committed = true;
                        } finally { if (!committed) Discard(stage); }
                    }
                    /* AFTER_ACTIVE_REPLACE */
                    var persisted = Read(chain, source);
                    if (Managed(administration) || persisted.bytes != Convert.ToBase64String(next)) return Result("uncertain");
                    return Result("written", persisted);
                }
            } catch {
                if (committed) return Result("uncertain");
                return op == "read" ? Result("snapshot", Masked(source, "unavailable")) : Result("failed");
            }
        }
    }

    public static Reply Execute(string op, string source, string[] administration, string expected, string content) {
        using (var session = new Session()) return session.Run(op, source, administration, expected, content);
    }
}
'@
$reply = [PredictionsPreferences]::Execute($request.op, $request.source, [string[]]$request.systemPaths, $request.expected, $request.bytes)
[Console]::WriteLine((ConvertTo-Json -InputObject $reply -Depth 4 -Compress))
`
