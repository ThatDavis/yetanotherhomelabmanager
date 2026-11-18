import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, type Device, type DeviceInterface, type SnmpProfileMeta } from "../api";
import { Drawer } from "../components/Drawer";
import { Panel } from "../components/Panel";
import { StatusBadge } from "../components/StatusBadge";

// NOC.1: SNMP device registration. Devices are identified live (TEST / IDENTIFY);
// polling arrives in NOC.2. SNMP is disabled by default on UniFi/MikroTik/TP-Link —
// the empty state points the operator at enabling it.
export function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [profiles, setProfiles] = useState<SnmpProfileMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editDevice, setEditDevice] = useState<Device | undefined>();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({}); // per-row TEST/IDENTIFY result

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        api<Device[]>("/devices"),
        api<SnmpProfileMeta[]>("/snmp-profiles"),
      ]);
      setDevices(d);
      setProfiles(p);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (id: string, text: string) => setNote((n) => ({ ...n, [id]: text }));

  const testDevice = async (d: Device) => {
    flash(d.id, "testing…");
    try {
      const res = await api<{
        ok: boolean;
        identity: { sysName: string; sysDescr: string; vendor: string };
      }>(`/devices/${d.id}/test`, { method: "POST" });
      flash(d.id, `ok: ${res.identity.sysName || res.identity.sysDescr || "reachable"}`);
    } catch (err) {
      flash(d.id, `fail: ${(err as Error).message}`);
    }
  };

  const identifyDevice = async (d: Device) => {
    flash(d.id, "identifying…");
    try {
      await api(`/devices/${d.id}/identify`, { method: "POST" });
      flash(d.id, "identified");
      await load();
    } catch (err) {
      flash(d.id, `fail: ${(err as Error).message}`);
    }
  };

  const removeDevice = async (d: Device) => {
    if (!window.confirm(`Remove device ${d.name} (${d.address})?`)) return;
    await api(`/devices/${d.id}`, { method: "DELETE" });
    await load();
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-mono text-lg text-text">Devices</h1>
        <button
          type="button"
          onClick={() => {
            setEditDevice(undefined);
            setDrawerOpen(true);
          }}
          className="chamfer-sm border border-surface1 px-3 py-1 font-mono text-sm text-sapphire hover:text-text"
        >
          + ADD DEVICE
        </button>
      </div>

      <Panel label="SNMP DEVICES">
        {error && <p className="font-mono text-sm text-status-error">API error: {error}</p>}
        {!error && devices.length === 0 && (
          <div className="py-4 text-center font-mono text-sm text-subtext0">
            <p>No SNMP devices registered yet.</p>
            <p className="mt-2 text-subtext0/70">
              SNMP is off by default on UniFi, MikroTik, and TP-Link — enable it on the device
              first, then add it here with a profile holding its community or v3 credentials.
            </p>
          </div>
        )}
        {devices.length > 0 && (
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <tr className="micro-label border-b border-surface1 text-left">
                <th className="py-2 pr-4 font-normal">NAME</th>
                <th className="py-2 pr-4 font-normal">ADDRESS</th>
                <th className="py-2 pr-4 font-normal">VENDOR</th>
                <th className="py-2 pr-4 font-normal">PROFILE</th>
                <th className="py-2 pr-4 font-normal">INTERFACES</th>
                <th className="py-2 pr-4 font-normal">LAST SEEN</th>
                <th className="py-2 font-normal">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  note={note[d.id]}
                  expanded={expanded === d.id}
                  onToggle={() => setExpanded(expanded === d.id ? null : d.id)}
                  onTest={() => testDevice(d)}
                  onIdentify={() => identifyDevice(d)}
                  onEdit={() => {
                    setEditDevice(d);
                    setDrawerOpen(true);
                  }}
                  onRemove={() => removeDevice(d)}
                />
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <DeviceDrawer
        open={drawerOpen}
        device={editDevice}
        profiles={profiles}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => {
          setDrawerOpen(false);
          void load();
        }}
      />
    </>
  );
}

function DeviceRow({
  device,
  note,
  expanded,
  onToggle,
  onTest,
  onIdentify,
  onEdit,
  onRemove,
}: {
  device: Device;
  note?: string;
  expanded: boolean;
  onToggle: () => void;
  onTest: () => void;
  onIdentify: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [interfaces, setInterfaces] = useState<DeviceInterface[] | null>(null);
  useEffect(() => {
    if (!expanded || interfaces) return;
    void api<Device & { interfaces: DeviceInterface[] }>(`/devices/${device.id}`).then((d) =>
      setInterfaces(d.interfaces),
    );
  }, [expanded, interfaces, device.id]);

  return (
    <>
      <tr className="border-b border-surface0 text-subtext1">
        <td className="py-2 pr-4 text-text">{device.name}</td>
        <td className="py-2 pr-4">{device.address}</td>
        <td className="py-2 pr-4">
          {device.vendor ? (
            <StatusBadge status="ok" label={device.vendor.toUpperCase()} />
          ) : (
            <span className="text-subtext0">—</span>
          )}
        </td>
        <td className="py-2 pr-4">
          {device.profile.name} <span className="text-subtext0">({device.profile.version})</span>
        </td>
        <td className="py-2 pr-4">{device.interfaceCount || "—"}</td>
        <td className="py-2 pr-4">
          {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "never"}
        </td>
        <td className="py-2">
          <div className="flex gap-3">
            <button type="button" onClick={onTest} className="text-sapphire hover:text-text">
              TEST
            </button>
            <button type="button" onClick={onIdentify} className="text-sapphire hover:text-text">
              IDENTIFY
            </button>
            <button type="button" onClick={onEdit} className="text-subtext0 hover:text-text">
              EDIT
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="text-subtext0 hover:text-status-error"
            >
              REMOVE
            </button>
            <button type="button" onClick={onToggle} className="text-subtext0 hover:text-text">
              {expanded ? "▾" : "▸"}
            </button>
          </div>
          {note && <div className="mt-1 text-xs text-subtext0">{note}</div>}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-surface0">
          <td colSpan={7} className="py-2">
            <div className="border border-surface0 bg-crust/40 px-3 py-2 font-mono text-xs">
              {device.sysDescr && (
                <div className="pb-1 text-subtext1">
                  {device.sysName && <span className="text-text">{device.sysName} · </span>}
                  {device.sysDescr}
                </div>
              )}
              {!interfaces && <div className="text-subtext0">loading interfaces…</div>}
              {interfaces?.length === 0 && (
                <div className="text-subtext0">no interfaces — run IDENTIFY</div>
              )}
              {interfaces?.map((i) => (
                <div key={i.id} className="flex gap-3 py-0.5">
                  <span className="text-text">{i.name}</span>
                  {i.alias && <span className="text-subtext1">{i.alias}</span>}
                  <span className="text-subtext0">{i.mac || "—"}</span>
                  <span className="text-subtext0">
                    {i.speedBps !== "0" ? `${Number(i.speedBps) / 1e9}G` : ""}
                  </span>
                  <span className={i.operStatus === "up" ? "text-status-ok" : "text-subtext0"}>
                    {i.operStatus}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DeviceDrawer({
  open,
  device,
  profiles,
  onClose,
  onSaved,
}: {
  open: boolean;
  device?: Device;
  profiles: SnmpProfileMeta[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [profileId, setProfileId] = useState("");
  const [newProfile, setNewProfile] = useState(false);
  const [pName, setPName] = useState("");
  const [pVersion, setPVersion] = useState<"v2c" | "v3">("v2c");
  const [pPort, setPPort] = useState(161);
  const [pCommunity, setPCommunity] = useState("");
  const [pUser, setPUser] = useState("");
  const [pAuthProto, setPAuthProto] = useState("sha");
  const [pAuthKey, setPAuthKey] = useState("");
  const [pPrivProto, setPPrivProto] = useState("aes256");
  const [pPrivKey, setPPrivKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(device?.name ?? "");
    setAddress(device?.address ?? "");
    setProfileId(device?.profileId ?? profiles[0]?.id ?? "");
    setNewProfile(profiles.length === 0);
    setError(null);
  }, [open, device, profiles]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      let pid = profileId;
      if (newProfile) {
        const created = await api<{ id: string }>("/snmp-profiles", {
          method: "POST",
          body: JSON.stringify({
            name: pName,
            version: pVersion,
            port: pPort,
            creds:
              pVersion === "v2c"
                ? { version: "v2c", community: pCommunity }
                : {
                    version: "v3",
                    user: pUser,
                    authProto: pAuthProto,
                    authKey: pAuthKey,
                    privProto: pPrivProto,
                    privKey: pPrivKey,
                  },
          }),
        });
        pid = created.id;
      }
      if (device) {
        await api(`/devices/${device.id}`, {
          method: "PUT",
          body: JSON.stringify({ name, address, profileId: pid }),
        });
      } else {
        await api("/devices", {
          method: "POST",
          body: JSON.stringify({ name, address, profileId: pid }),
        });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const input = "w-full border border-surface1 bg-crust px-2 py-1 font-mono text-sm text-text";

  return (
    <Drawer title={device ? `EDIT ${device.name}` : "ADD DEVICE"} open={open} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <label className="font-mono text-xs text-subtext0">
          NAME
          <input
            className={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="font-mono text-xs text-subtext0">
          ADDRESS (IP or DNS)
          <input
            className={input}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            required
          />
        </label>

        {!newProfile && (
          <label className="font-mono text-xs text-subtext0">
            SNMP PROFILE
            <select
              className={input}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.version})
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => setNewProfile(!newProfile)}
          className="text-left font-mono text-xs text-sapphire hover:text-text"
        >
          {newProfile ? "▾ new profile" : "▸ new profile"}
        </button>

        {newProfile && (
          <div className="flex flex-col gap-3 border border-surface0 p-3">
            <label className="font-mono text-xs text-subtext0">
              PROFILE NAME
              <input
                className={input}
                value={pName}
                onChange={(e) => setPName(e.target.value)}
                required
              />
            </label>
            <label className="font-mono text-xs text-subtext0">
              VERSION
              <select
                className={input}
                value={pVersion}
                onChange={(e) => setPVersion(e.target.value as "v2c" | "v3")}
              >
                <option value="v2c">v2c (community)</option>
                <option value="v3">v3 (authPriv)</option>
              </select>
            </label>
            <label className="font-mono text-xs text-subtext0">
              PORT
              <input
                className={input}
                type="number"
                value={pPort}
                onChange={(e) => setPPort(Number(e.target.value))}
              />
            </label>
            {pVersion === "v2c" ? (
              <label className="font-mono text-xs text-subtext0">
                COMMUNITY
                <input
                  className={input}
                  type="password"
                  value={pCommunity}
                  onChange={(e) => setPCommunity(e.target.value)}
                  required
                />
              </label>
            ) : (
              <>
                <label className="font-mono text-xs text-subtext0">
                  USER
                  <input
                    className={input}
                    value={pUser}
                    onChange={(e) => setPUser(e.target.value)}
                    required
                  />
                </label>
                <label className="font-mono text-xs text-subtext0">
                  AUTH PROTOCOL
                  <select
                    className={input}
                    value={pAuthProto}
                    onChange={(e) => setPAuthProto(e.target.value)}
                  >
                    <option value="sha">SHA-1</option>
                    <option value="sha256">SHA-256</option>
                    <option value="sha512">SHA-512</option>
                    <option value="md5">MD5 (legacy)</option>
                  </select>
                </label>
                <label className="font-mono text-xs text-subtext0">
                  AUTH KEY
                  <input
                    className={input}
                    type="password"
                    value={pAuthKey}
                    onChange={(e) => setPAuthKey(e.target.value)}
                    required
                    minLength={8}
                  />
                </label>
                <label className="font-mono text-xs text-subtext0">
                  PRIV PROTOCOL (DES unsupported on Node 22 — AES only)
                  <select
                    className={input}
                    value={pPrivProto}
                    onChange={(e) => setPPrivProto(e.target.value)}
                  >
                    <option value="aes256">AES-256</option>
                    <option value="aes">AES-128</option>
                  </select>
                </label>
                <label className="font-mono text-xs text-subtext0">
                  PRIV KEY
                  <input
                    className={input}
                    type="password"
                    value={pPrivKey}
                    onChange={(e) => setPPrivKey(e.target.value)}
                    required
                    minLength={8}
                  />
                </label>
              </>
            )}
            <p className="font-mono text-xs text-subtext0/70">
              Credentials are stored encrypted in the Secret store, never in the device tables.
            </p>
          </div>
        )}

        {error && <p className="font-mono text-sm text-status-error">{error}</p>}
        <button
          type="submit"
          className="chamfer-sm border border-sapphire px-3 py-1 font-mono text-sm text-sapphire hover:bg-sapphire/10"
        >
          {device ? "SAVE" : "ADD"}
        </button>
      </form>
    </Drawer>
  );
}
