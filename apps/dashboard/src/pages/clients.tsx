import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  QrCode,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Loading, PageHeader, QueryError } from "@/components/common";
import { useOverview } from "@/components/layout";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage, unwrap, type Overview } from "@/lib/api";
import { cn } from "@/lib/utils";
import { copy } from "@/lib/utils-dom";

// Clients (docs/web-unified-plan.md): how each screen in the house watches from this server. At the top, the
// screens on a shelf as small drawings, the web first (chosen at first): /app/, one address that opens the client
// made for the screen, then the TV, a computer, a tablet and a phone, each showing what /app/ opens on it (the
// admin's choice under the computer and the tablet). The web shows the address (Open, Copy, QR code, each client
// behind it served or not); a screen shows the apps to install on it (their files from GitHub's releases, the
// server's version else the newest published); every screen shows all of it and the TV's own player (DLNA).

type View = "tv" | "mobile";
type Device = "web" | "tv" | "computer" | "tablet" | "phone";
type Os = "windows" | "macos" | "linux" | "android" | "ios";

const DEVICES: { id: Device; name: string; on: string; systems: Os[] }[] = [
  { id: "web", name: "Web", on: "a browser", systems: [] },
  { id: "tv", name: "TV", on: "a TV", systems: [] },
  {
    id: "computer",
    name: "Computer",
    on: "a computer",
    systems: ["windows", "macos", "linux"],
  },
  { id: "tablet", name: "Tablet", on: "a tablet", systems: ["android", "ios"] },
  { id: "phone", name: "Phone", on: "a phone", systems: ["android", "ios"] },
];
const OS_NAME: Record<Os, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iPhone & iPad",
};
const VIEW_NAME: Record<View, string> = {
  tv: "Playpex TV",
  mobile: "Playpex Mobile",
};
const SHOT: Record<View, string> = {
  tv: "/clients/tv-web.webp",
  mobile: "/clients/mobile-web.webp",
};

// the apps' published releases (GitHub's public API, read by this browser, kept an hour): a tag per app and
// version (`tv-v0.10.1-alpha.1`), the files attached to it
const RELEASES_API =
  "https://api.github.com/repos/IhebBelhadj/Playpex/releases?per_page=40";
const SITE_RELEASES = "https://playpex.pages.dev/releases";

interface GhRelease {
  tag_name: string;
  draft: boolean;
  assets: { name: string; browser_download_url: string }[];
}

interface AppFile {
  os: Os;
  label: string;
  /** the release's file it is */
  match: RegExp;
}

interface App {
  id: string;
  name: string;
  about: string;
  devices: Device[];
  shot: string;
  phone?: boolean;
  tag: string;
  files: AppFile[];
  /** why a system of these devices has no build */
  missing: Partial<Record<Os, string>>;
}

const APPS: App[] = [
  {
    id: "tv-app",
    name: "Playpex TV",
    about:
      "For the computer plugged into your TV: opens full screen, finds this server by itself, takes a remote.",
    devices: ["computer"],
    shot: "/clients/tv-app.webp",
    tag: "tv",
    files: [
      {
        os: "windows",
        label: "Installer for Windows",
        match: /^Playpex-TV-Setup-.*\.exe$/,
      },
      { os: "linux", label: "AppImage for Linux", match: /\.AppImage$/ },
      { os: "linux", label: ".deb package", match: /\.deb$/ },
    ],
    missing: {
      macos: "Not built for macOS yet. Open Playpex TV in the browser instead.",
    },
  },
  {
    id: "mobile-app",
    name: "Playpex Mobile",
    about:
      "Plays every file as it is, with all its sound tracks and subtitles, and works as a remote for your screens.",
    devices: ["phone", "tablet"],
    shot: "/clients/mobile-app.webp",
    phone: true,
    tag: "android",
    files: [
      { os: "android", label: "APK for phones", match: /-arm64\.apk$/ },
      {
        os: "android",
        label: "APK for emulators and Chromebooks",
        match: /-x86_64\.apk$/,
      },
    ],
    missing: {
      ios: "No iPhone app yet. Playpex Mobile in the browser does the same.",
    },
  },
  {
    id: "manager",
    name: "Server Manager",
    about:
      "Finds this server on the Wi-Fi and opens this dashboard on your phone, with the remote for every screen.",
    devices: ["phone"],
    shot: "/clients/manager.webp",
    phone: true,
    tag: "manager",
    files: [{ os: "android", label: "APK for Android", match: /\.apk$/ }],
    missing: { ios: "For Android phones only." },
  },
];

/** The screen and system this browser runs on */
function thisDevice(): { device: Device; os: Os | null } | null {
  const ua = navigator.userAgent;
  if (
    /SmartTV|SMART-TV|Tizen|Web0S|webOS|HbbTV|BRAVIA|AFT[A-Z]|Android ?TV|Google ?TV/i.test(
      ua,
    )
  )
    return { device: "tv", os: null };
  const touchOnly =
    window.matchMedia?.("(pointer: coarse)").matches &&
    !window.matchMedia?.("(any-pointer: fine)").matches;
  const tablet = Math.min(screen.width, screen.height) >= 600;
  if (/Android/i.test(ua))
    return { device: tablet ? "tablet" : "phone", os: "android" };
  if (
    /iPad/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  )
    return { device: "tablet", os: "ios" };
  if (/iPhone|iPod/i.test(ua)) return { device: "phone", os: "ios" };
  if (touchOnly) return { device: tablet ? "tablet" : "phone", os: null };
  if (/Windows/i.test(ua)) return { device: "computer", os: "windows" };
  if (/Macintosh|Mac OS X/i.test(ua))
    return { device: "computer", os: "macos" };
  if (/Linux|X11|CrOS/i.test(ua)) return { device: "computer", os: "linux" };
  return null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOOPBACK = /^(localhost|127\.|\[?::1\]?$)/;

/**
 * The address other devices reach, always an IP address: the `.local` name isn't resolved by every device (many
 * phones, TVs and Windows machines don't), so it never goes in a link. This page's own address when it is already a
 * LAN one, else the server's first LAN address (the server lists them without container / VPN bridges, the one its
 * default route uses first: apps/server/lib/network.js), else this page's
 */
function serverBase(server: Overview["server"] | undefined): string {
  const here = window.location.hostname;
  if (IPV4.test(here) && !LOOPBACK.test(here)) return window.location.origin;
  const lan = (server?.urls ?? [])
    .map((u) => {
      try {
        return new URL(u);
      } catch {
        return null;
      }
    })
    .filter(
      (u): u is URL =>
        !!u && IPV4.test(u.hostname) && !LOOPBACK.test(u.hostname),
    )[0];
  return lan ? lan.origin : window.location.origin;
}

/** This app's release: the one of the server's version when it is published, else its newest */
function releaseOf(
  list: GhRelease[],
  tag: string,
  serverVersion: string | null,
): { version: string; release: GhRelease } | null {
  const prefix = `${tag}-v`;
  const ours = list.filter((r) => !r.draft && r.tag_name.startsWith(prefix));
  const release =
    ours.find((r) => r.tag_name === prefix + serverVersion) ?? ours[0];
  return release
    ? { version: release.tag_name.slice(prefix.length), release }
    : null;
}

type Patch = Partial<
  Record<"tvWeb" | "mobileWeb", boolean> & Record<"computers" | "tablets", View>
>;

export function ClientsPage() {
  const overview = useOverview();
  const client = useQueryClient();
  const clients = useQuery({
    queryKey: ["clients"],
    queryFn: () => unwrap(api.GET("/clients")),
  });
  const dlna = useQuery({
    queryKey: ["dlna"],
    queryFn: () => unwrap(api.GET("/admin/dlna")),
  });
  const releases = useQuery({
    queryKey: ["client-releases"],
    queryFn: async (): Promise<GhRelease[]> => {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 60_000,
    retry: 1,
  });
  const [here] = useState(thisDevice);
  // the web first: one address for every browser; a screen below it shows its apps
  const [device, setDevice] = useState<Device | null>("web");
  const [os, setOs] = useState<Os | null>(here?.os ?? null);
  const save = useMutation({
    mutationFn: (patch: Patch) =>
      unwrap(api.PUT("/admin/settings", { body: { clients: patch } })),
    onSuccess: (r) => {
      client.setQueryData(["settings"], r.settings);
      void client.invalidateQueries({ queryKey: ["clients"] });
      toast.success("Saved");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (clients.isPending) return <Loading rows={4} />;
  if (clients.error) return <QueryError error={clients.error} />;
  const base = serverBase(overview.data?.server);
  const host = base.replace(/^https?:\/\//, "");
  const version = overview.data?.server.version ?? null;
  const { web, open } = clients.data;
  const opens: Record<Exclude<Device, "web">, View> = {
    tv: "tv",
    computer: open.computers,
    tablet: open.tablets,
    phone: "mobile",
  };

  const chosen = DEVICES.find((d) => d.id === device) ?? null;
  const system = chosen && os && chosen.systems.includes(os) ? os : null;
  const choose = (d: Device) => {
    if (d === device) return setDevice(null);
    setDevice(d);
    const systems = DEVICES.find((x) => x.id === d)!.systems;
    if (!os || !systems.includes(os))
      setOs(
        here && systems.includes(here.os as Os)
          ? here.os
          : (systems[0] ?? null),
      );
  };

  // Web: the one address; a screen: the apps to install on it; every screen: all of it
  const showWeb = !chosen || chosen.id === "web";
  const apps =
    chosen?.id === "web"
      ? []
      : APPS.filter((a) => !chosen || a.devices.includes(chosen.id));
  const showDlna = !chosen;

  return (
    <>
      <PageHeader
        title="Clients"
        description="How each screen in the house watches from this server."
      />

      <section className="rounded-xl bg-card p-5 max-sm:rounded-[12px] sm:p-8">
        <Shelf
          device={device}
          opens={opens}
          busy={save.isPending}
          onChoose={choose}
          onOpens={(d, v) =>
            save.mutate(d === "computer" ? { computers: v } : { tablets: v })
          }
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">
          {!chosen
            ? "Works on every screen"
            : chosen.id === "web"
              ? "Works in a browser"
              : `Works on ${chosen.on}`}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          {chosen && chosen.systems.length > 0 && (
            <div
              className="inline-flex rounded-full bg-muted p-1"
              role="group"
              aria-label="System"
            >
              {chosen.systems.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={system === s}
                  onClick={() => setOs(s)}
                  className={cn(
                    "h-7 rounded-full px-3 text-sm transition-colors",
                    system === s
                      ? "bg-gold text-gold-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {OS_NAME[s]}
                </button>
              ))}
            </div>
          )}
          {chosen && (
            <Button size="sm" variant="ghost" onClick={() => setDevice(null)}>
              Every screen
            </Button>
          )}
        </div>
      </div>

      {showWeb && (
        <Group
          title="In the browser"
          note="Nothing to install: open the address and pair once."
        >
          <WebRow
            url={`${base}/app/`}
            address={`${host}/app/`}
            web={web}
            device={chosen && chosen.id !== "web" ? chosen.id : null}
            opens={opens}
            lanSharing={overview.data?.server.lanSharing !== false}
            busy={save.isPending}
            onServe={(v, on) =>
              save.mutate(v === "tv" ? { tvWeb: on } : { mobileWeb: on })
            }
          />
        </Group>
      )}

      {chosen?.id === "tv" && (
        <Group title="Apps to install">
          <p className="p-5 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              No Playpex app runs on a TV yet.
            </span>{" "}
            Open Playpex on the web in the TV’s browser, or plug in a computer
            with Playpex TV.
          </p>
        </Group>
      )}

      {apps.length > 0 && (
        <Group
          title="Apps to install"
          note="Downloads from Playpex’s releases on GitHub."
        >
          {apps.map((a) => (
            <AppRow
              key={a.id}
              app={a}
              os={system}
              serverVersion={version}
              releases={releases}
            />
          ))}
        </Group>
      )}

      {showDlna && (
        <Group title="On the TV itself">
          <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-[62ch] text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                Your TV’s own media player
              </span>{" "}
              can browse the folders you share over DLNA, with no app and no
              pairing. So can consoles, VLC and Kodi.{" "}
              {dlna.data ? (dlna.data.enabled ? "It’s on." : "It’s off.") : ""}
            </p>
            <Button size="sm" variant="outline" asChild className="shrink-0">
              <Link to="/settings/dlna">
                {dlna.data?.enabled ? "Choose the folders" : "Turn on DLNA"}
              </Link>
            </Button>
          </div>
        </Group>
      )}
    </>
  );
}

/**
 * The screens of the house, small drawings standing on one line: the web first (what /app/ is), then each screen
 * showing what /app/ opens on it. A screen is a button: it shows what works on it below (again: every screen).
 * Under the computer and the tablet, the admin's choice
 */
function Shelf(props: {
  device: Device | null;
  opens: Record<Exclude<Device, "web">, View>;
  busy: boolean;
  onChoose: (d: Device) => void;
  onOpens: (d: Device, v: View) => void;
}) {
  const { device, opens, busy, onChoose, onOpens } = props;
  const { track, move, back, forward, scrolls } = useCarousel();
  return (
    <div role="group" aria-label="Screens" className="relative">
      {back && <CarouselButton side="back" onClick={() => move(-1)} />}
      {forward && <CarouselButton side="forward" onClick={() => move(1)} />}
      <div
        ref={track}
        // a scroller clips both ways: the row scrolls only when it overflows (else nothing is clipped), with room
        // then for the chosen screen's lift and its focus ring
        className={cn(
          "flex items-start",
          scrolls &&
            "-mx-3 -mt-3 snap-x snap-mandatory scroll-px-3 overflow-x-auto px-3 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {DEVICES.map((d, i) => {
          const on = device === d.id;
          const last = i === DEVICES.length - 1;
          return (
            <div
              key={d.id}
              className={cn(
                "flex shrink-0 snap-start flex-col",
                !last && "pr-3.5 sm:pr-8",
              )}
            >
              <button
                type="button"
                aria-pressed={on}
                aria-label={`${d.name}: show what works on ${d.on}`}
                onClick={() => onChoose(d.id)}
                className={cn(
                  "group flex h-10 items-end self-start rounded-[5px] outline-none sm:h-[52px]",
                  "focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-4 focus-visible:ring-offset-card",
                  "transition-[opacity,translate] duration-200 motion-reduce:transition-none",
                  device !== null && !on
                    ? "opacity-45 hover:opacity-80"
                    : "opacity-100",
                  on && "-translate-y-0.5",
                )}
              >
                <Screen
                  device={d.id}
                  view={d.id === "web" ? "tv" : opens[d.id]}
                  on={on}
                />
              </button>
              <div className="mt-2.5 border-t" aria-hidden="true">
                <div
                  className={cn(
                    "-mt-px h-0.5 transition-colors",
                    !last && "mr-3.5 sm:mr-8",
                    on ? "bg-gold" : "bg-transparent",
                  )}
                />
              </div>
              <button
                type="button"
                onClick={() => onChoose(d.id)}
                tabIndex={-1}
                className={cn(
                  "mt-2 self-start text-[13px] font-medium",
                  on ? "text-gold" : "text-foreground",
                )}
              >
                {d.name}
              </button>
              {d.id === "computer" || d.id === "tablet" ? (
                <div className="max-sm:hidden">
                  <Select
                    value={opens[d.id]}
                    disabled={busy}
                    onValueChange={(v) => onOpens(d.id, v as View)}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={`What ${d.on} opens`}
                      className="-ml-2.5 h-6 w-auto border-transparent bg-transparent px-2.5 text-xs text-muted-foreground shadow-none hover:text-foreground"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tv">opens Playpex TV</SelectItem>
                      <SelectItem value="mobile">
                        opens Playpex Mobile
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <p className="py-1 text-xs whitespace-nowrap text-muted-foreground max-sm:hidden">
                  {d.id === "web"
                    ? "picks for the screen"
                    : `opens ${VIEW_NAME[opens[d.id]]}`}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A row that turns into a carousel when it overflows: its own scrollbar hidden, a back / forward button at the ends
 * that can still move (a scroll by most of the row's width, snapping to an item), kept right on resize
 */
function useCarousel() {
  const track = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({
    back: false,
    forward: false,
    scrolls: false,
  });
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const update = () =>
      setEnds({
        back: el.scrollLeft > 2,
        forward: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
        // its content wider than it (measured the same whether it scrolls or not)
        scrolls: el.scrollWidth > el.clientWidth + 2,
      });
    update();
    const resize = new ResizeObserver(update);
    resize.observe(el);
    for (const child of Array.from(el.children)) resize.observe(child);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      resize.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);
  const move = (direction: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const still = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollBy({
      left: direction * Math.max(el.clientWidth * 0.8, 80),
      behavior: still ? "auto" : "smooth",
    });
  };
  return { track, move, ...ends };
}

/** A carousel's back or forward button, over the screens' row at that end */
function CarouselButton({
  side,
  onClick,
}: {
  side: "back" | "forward";
  onClick: () => void;
}) {
  const Icon = side === "back" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "back" ? "Earlier screens" : "More screens"}
      className={cn(
        "absolute top-1 z-10 flex size-8 items-center justify-center rounded-full bg-muted text-foreground ring-4 ring-card transition-colors hover:bg-foreground hover:text-background sm:top-2.5",
        "outline-none focus-visible:ring-gold",
        side === "back" ? "left-0" : "right-0",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

/** A screen's outline with what it shows: a browser window, a TV on its stand, a laptop, a tablet, a phone */
function Screen({
  device,
  view,
  on,
}: {
  device: Device;
  view: View;
  on: boolean;
}) {
  const frame = on
    ? "border-foreground"
    : "border-muted-foreground/60 group-hover:border-muted-foreground";
  const ink = on ? "bg-foreground" : "bg-muted-foreground/60";
  const shot = (
    <img
      src={SHOT[view]}
      alt=""
      loading="lazy"
      className={cn(
        "size-full object-top",
        view === "mobile" && (device === "tv" || device === "computer")
          ? "object-contain"
          : "object-cover",
      )}
    />
  );
  if (device === "web") {
    return (
      <div
        className={cn(
          "flex aspect-[16/11] h-full flex-col overflow-hidden rounded-[4px] border-2 bg-black transition-colors",
          frame,
        )}
      >
        <div className="flex h-2 shrink-0 items-center gap-0.5 bg-muted px-1">
          <i className="size-[3px] rounded-full bg-muted-foreground/60" />
          <i className="size-[3px] rounded-full bg-muted-foreground/60" />
          <i className="size-[3px] rounded-full bg-muted-foreground/60" />
        </div>
        <div className="min-h-0 flex-1">{shot}</div>
      </div>
    );
  }
  if (device === "tv") {
    return (
      <div className="flex h-full flex-col items-center justify-end">
        <div
          className={cn(
            "aspect-video h-[calc(100%-8px)] overflow-hidden rounded-[3px] border-2 bg-black transition-colors",
            frame,
          )}
        >
          {shot}
        </div>
        <div className={cn("h-1.5 w-0.5 transition-colors", ink)} />
        <div
          className={cn("h-0.5 w-[30%] rounded-full transition-colors", ink)}
        />
      </div>
    );
  }
  if (device === "computer") {
    return (
      <div className="flex h-full flex-col items-center justify-end px-[5px]">
        <div
          className={cn(
            "aspect-[16/10] h-[calc(100%-4px)] overflow-hidden rounded-t-[3px] border-2 border-b-[3px] bg-black transition-colors",
            frame,
          )}
        >
          {shot}
        </div>
        <div
          className={cn(
            "-mx-[5px] h-1 self-stretch rounded-b-[3px] transition-colors",
            ink,
          )}
        />
      </div>
    );
  }
  if (device === "tablet")
    return (
      <div
        className={cn(
          "aspect-[3/4] h-full overflow-hidden rounded-[5px] border-[3px] bg-black transition-colors",
          frame,
        )}
      >
        {shot}
      </div>
    );
  return (
    <div
      className={cn(
        // a phone, not a pill: small corners for its size, the bezels above and below the screen thicker than at its sides
        "aspect-[9/19] h-[92%] overflow-hidden rounded-[5px] border-x-2 border-y-[5px] bg-black transition-colors",
        frame,
      )}
    >
      {shot}
    </div>
  );
}

function Group({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h3 className="text-base font-medium">{title}</h3>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      <div className="divide-y overflow-hidden rounded-xl bg-card max-sm:rounded-[12px]">
        {children}
      </div>
    </section>
  );
}

type WebClient = { id: string; enabled: boolean; built: boolean };

/**
 * Playpex on the web: the one address (/app/) that opens the client made for the screen. Its picture in a browser
 * window, what it opens on the screen chosen, how to open it, and whether each client behind it is served
 */
function WebRow(props: {
  url: string;
  address: string;
  web: WebClient[];
  /** the screen chosen on the shelf (null: the web, or every screen) */
  device: Exclude<Device, "web"> | null;
  opens: Record<Exclude<Device, "web">, View>;
  lanSharing: boolean;
  busy: boolean;
  onServe: (view: View, on: boolean) => void;
}) {
  const { url, address, web, device, opens, lanSharing, busy, onServe } = props;
  const info = (v: View) => web.find((w) => w.id === v);
  const serves = (v: View) => !!info(v)?.enabled && !!info(v)?.built;
  const other = (v: View): View => (v === "tv" ? "mobile" : "tv");
  // what /app/ opens on the chosen screen: its client, else the other one (entry.js falls back the same way)
  const lands = device
    ? serves(opens[device])
      ? opens[device]
      : serves(other(opens[device]))
        ? other(opens[device])
        : null
    : null;
  const where = DEVICES.find((d) => d.id === device);
  const note = !device
    ? "A TV or a computer gets Playpex TV, a phone or a tablet Playpex Mobile."
    : lands
      ? `On ${where!.on} it opens ${VIEW_NAME[lands]}.`
      : "Both apps are off, so it says nothing is served.";
  const missing = (["tv", "mobile"] as View[]).filter((v) => !info(v)?.built);
  return (
    <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,17.5rem)_1fr] md:gap-7">
      <div className="overflow-hidden rounded-lg bg-muted max-sm:rounded-[8px]">
        <div
          className="flex items-center gap-1.5 px-2.5 py-1.5"
          aria-hidden="true"
        >
          <i className="size-1.5 rounded-full bg-muted-foreground/50" />
          <i className="size-1.5 rounded-full bg-muted-foreground/50" />
          <i className="size-1.5 rounded-full bg-muted-foreground/50" />
          <span className="ml-1 min-w-0 truncate text-[10px] text-muted-foreground">
            {address}
          </span>
        </div>
        <div className="relative aspect-video overflow-hidden bg-black">
          {(device ? opens[device] : "tv") === "tv" ? (
            <img
              src={SHOT.tv}
              alt=""
              loading="lazy"
              className="size-full object-cover object-top"
            />
          ) : (
            <div className="flex h-full justify-center pt-2">
              <img
                src={SHOT.mobile}
                alt=""
                loading="lazy"
                className="w-2/5 rounded-t-md object-cover object-top"
              />
            </div>
          )}
          {!device && (
            // a whole phone standing in front of the TV app, at a phone's 9:19, never cut by the window
            <div className="absolute right-[7%] bottom-[7%] aspect-[9/19] h-[86%] overflow-hidden rounded-[10px] border-[3px] border-black bg-black">
              <img
                src={SHOT.mobile}
                alt=""
                loading="lazy"
                className="size-full object-cover object-top"
              />
            </div>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3.5">
        <div className="min-w-0">
          <h4 className="text-lg leading-snug font-semibold">
            Playpex on the web
          </h4>
          <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground">
            One address for every browser. It looks at the screen it opens on
            and starts the app made for it. {note}
          </p>
          {!lanSharing && (
            <p className="mt-2 text-xs text-muted-foreground">
              This server only listens on this machine. Turn on sharing in
              Settings › Network so other screens reach it.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {(["tv", "mobile"] as View[]).map((v) => {
            const c = info(v);
            const id = `serve-${v}`;
            return (
              <label
                key={v}
                htmlFor={id}
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <Switch
                  id={id}
                  checked={!!c?.enabled}
                  disabled={busy || !c}
                  onCheckedChange={(on) => onServe(v, on)}
                />
                {VIEW_NAME[v]}{" "}
                {!c?.built
                  ? "isn’t built"
                  : c.enabled
                    ? "served"
                    : "turned off"}
              </label>
            );
          })}
        </div>
        {missing.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Build it on this server with{" "}
            {missing.map((v, i) => (
              <span key={v}>
                {i > 0 && " and "}
                <code className="font-mono">
                  {v === "tv"
                    ? "npm run build:tv-web"
                    : "npm run build:mobile-web"}
                </code>
              </span>
            ))}
            .
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2">
          <Button size="sm" asChild>
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink /> Open
            </a>
          </Button>
          <CopyButton url={url} />
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline">
                <QrCode /> QR code
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-3">
              <Qr text={url} size={176} />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}

/** An app to install: its downloads for the system chosen (every system's without one), or why it has none */
function AppRow(props: {
  app: App;
  os: Os | null;
  serverVersion: string | null;
  releases: { data?: GhRelease[]; isPending: boolean; isError: boolean };
}) {
  const { app, os, serverVersion, releases } = props;
  const found = releases.data
    ? releaseOf(releases.data, app.tag, serverVersion)
    : null;
  const missing = os ? app.missing[os] : undefined;
  const files = found
    ? app.files
        .filter((f) => !os || f.os === os)
        .map((f) => ({
          ...f,
          asset: found.release.assets.find(
            (a) => f.match.test(a.name) && !a.name.endsWith(".blockmap"),
          ),
        }))
        .filter((f) => f.asset)
    : [];
  const systems = [...new Set(app.files.map((f) => OS_NAME[f.os]))];
  return (
    <div
      className={cn(
        "grid gap-4 p-5 sm:grid-cols-[6rem_1fr] sm:gap-6",
        missing && "opacity-70",
      )}
    >
      <div className="hidden h-[4.5rem] items-start justify-center overflow-hidden rounded-md bg-muted sm:flex">
        <img
          src={app.shot}
          alt=""
          loading="lazy"
          className={cn(
            "object-cover object-top",
            app.phone ? "mt-2 w-9 rounded-t-[3px]" : "size-full",
          )}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-8">
        <div className="min-w-0">
          <h4 className="leading-snug font-semibold">
            {app.name}{" "}
            <span className="font-normal text-muted-foreground">
              for {systems.join(" and ")}
            </span>
          </h4>
          <p className="mt-1 max-w-[56ch] text-sm text-muted-foreground">
            {missing ?? app.about}
          </p>
          {found && !missing && (
            <p className="mt-2 text-xs text-muted-foreground">
              Version {found.version}
              {serverVersion && found.version !== serverVersion
                ? ", the newest published"
                : ""}
              .{" "}
              <a
                className="underline-offset-4 hover:text-foreground hover:underline"
                href={SITE_RELEASES}
                target="_blank"
                rel="noreferrer"
              >
                Other versions
              </a>
            </p>
          )}
        </div>
        {!missing && (
          <div className="flex shrink-0 flex-col gap-2 md:items-end">
            {releases.isPending ? (
              <p className="text-sm text-muted-foreground">
                Looking for its downloads…
              </p>
            ) : files.length ? (
              files.map((f, i) => (
                <Button
                  key={f.asset!.name}
                  size="sm"
                  variant={i === 0 ? "default" : "outline"}
                  asChild
                >
                  <a href={f.asset!.browser_download_url} rel="noreferrer">
                    <Download /> {f.label}
                  </a>
                </Button>
              ))
            ) : (
              <Button size="sm" variant="outline" asChild>
                <a href={SITE_RELEASES} target="_blank" rel="noreferrer">
                  <ExternalLink />{" "}
                  {releases.isError
                    ? "Download from playpex.pages.dev"
                    : "See the releases"}
                </a>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CopyButton({ url }: { url: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        if (await copy(url)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } else toast.error("The browser refused to copy");
      }}
    >
      {done ? <Check /> : <Copy />} {done ? "Copied" : "Copy"}
    </Button>
  );
}

function Qr({ text, size }: { text: string; size: number }) {
  // dark modules on white whatever the theme: what cameras read best
  const qr = useQuery({
    queryKey: ["qr", text],
    queryFn: () =>
      QRCode.toDataURL(text, {
        margin: 1,
        width: size * 2,
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" },
      }),
    staleTime: Infinity,
  });
  return (
    <div
      className="shrink-0 self-start overflow-hidden rounded-2xl bg-white p-2"
      style={{ width: size, height: size }}
    >
      {qr.data && (
        <img
          src={qr.data}
          alt={`QR code for ${text}`}
          width={size - 16}
          height={size - 16}
        />
      )}
    </div>
  );
}
