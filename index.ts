import "dotenv/config";
import express, { type Request, type Response } from "express";
import crypto from "crypto";
import open from "open";
import fs from "fs";

/* -------------------- config -------------------- */

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI!;
if (!CLIENT_ID || !REDIRECT_URI) {
  throw new Error("Missing SPOTIFY_CLIENT_ID or SPOTIFY_REDIRECT_URI in .env");
}

const SCOPES = ["playlist-modify-private", "playlist-modify-public"];

/* -------------------- types -------------------- */

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
};

type AlbumTracksPage = {
  items: Array<{ uri: string }>;
  next: string | null;
};

/* -------------------- utils -------------------- */

function base64Url(buf: Buffer) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sha256(v: string) {
  return crypto.createHash("sha256").update(v).digest();
}

function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/’/g, "'")
    .replace(/[^a-z0-9\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function keyFor(artist: string, album: string) {
  return `${artist} - ${album}`.trim();
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!fs.existsSync(path)) return fallback;
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function albumIdFromOverride(v: string) {
  const m = v.match(/^spotify:album:(.+)$/);
  return m ? m[1] : v;
}

/* -------------------- spotify api -------------------- */

async function spotifyFetch<T>(
  url: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

async function getMe(token: string) {
  return spotifyFetch<{ id: string }>("https://api.spotify.com/v1/me", token);
}

async function createPlaylist(
  token: string,
  userId: string,
  name: string,
  isPublic: boolean
) {
  return spotifyFetch<{ id: string; external_urls: { spotify: string } }>(
    `https://api.spotify.com/v1/users/${userId}/playlists`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        public: isPublic,
        description: "Generated from album list",
      }),
    }
  );
}

async function searchAlbum(token: string, artist: string, album: string) {
  const strictQ = `album:${album} artist:${artist}`;
  const strict = await spotifyFetch<any>(
    `https://api.spotify.com/v1/search?type=album&limit=10&q=${encodeURIComponent(
      strictQ
    )}`,
    token
  );

  const targetA = normalize(artist);
  const targetB = normalize(album);

  const exact =
    strict.albums.items.find(
      (i: any) =>
        normalize(i.name) === targetB &&
        normalize(i.artists[0].name) === targetA
    ) || strict.albums.items.find((i: any) => normalize(i.name) === targetB);

  if (exact) return exact;

  const loose = await spotifyFetch<any>(
    `https://api.spotify.com/v1/search?type=album&limit=10&q=${encodeURIComponent(
      `${artist} ${album}`
    )}`,
    token
  );

  const sameArtist = loose.albums.items.filter(
    (i: any) => normalize(i.artists[0].name) === targetA
  );

  const pool = sameArtist.length ? sameArtist : loose.albums.items;

  return (
    pool.find((i: any) => normalize(i.name).includes(targetB)) ||
    pool[0] ||
    null
  );
}

async function getAlbumTracks(token: string, albumId: string) {
  const uris: string[] = [];
  let next:
    | string
    | null = `https://api.spotify.com/v1/albums/${albumId}/tracks?limit=50`;

  while (next) {
    const page: AlbumTracksPage = await spotifyFetch<AlbumTracksPage>(
      next,
      token
    );
    uris.push(...page.items.map((t) => t.uri));
    next = page.next;
  }
  return uris;
}

async function addTracks(token: string, playlistId: string, uris: string[]) {
  for (let i = 0; i < uris.length; i += 100) {
    await spotifyFetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
      }
    );
  }
}

/* -------------------- list parsing -------------------- */

function parseList(path: string) {
  if (!fs.existsSync(path)) {
    throw new Error(`List file not found: ${path}`);
  }

  return fs
    .readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l: string) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [artist, ...rest] = l.split(" - ");
      return { artist, album: rest.join(" - ") };
    });
}

/* -------------------- main -------------------- */

async function main() {
  const listPath = process.argv[2] || "playlist.txt";
  // default playlist name
  const playlistName = process.argv[3] || "Simply Created Playlist";
  const isPublic = (process.argv[4] || "private") === "public";

  const entries = parseList(listPath);
  const overrides = readJson<Record<string, string>>("overrides.json", {});
  const misses: any[] = [];

  const app = express();
  const port = 5173;

  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(sha256(verifier));
  const state = base64Url(crypto.randomBytes(16));

  const authUrl =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(" "),
      state,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });

  const server = app.listen(port, () => {
    console.log(`Auth server running on http://127.0.0.1:${port}`);
    open(authUrl);
  });

  app.get("/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string;

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    const tokens = (await tokenRes.json()) as TokenResponse;
    res.send("Authorized. You may close this tab.");
    server.close();

    const me = await getMe(tokens.access_token);
    const playlist = await createPlaylist(
      tokens.access_token,
      me.id,
      playlistName,
      isPublic
    );

    console.log(`\nCreated playlist: ${playlist.external_urls.spotify}\n`);

    for (let i = 0; i < entries.length; i++) {
      const { artist, album } = entries[i];
      const key = keyFor(artist, album);

      process.stdout.write(`[${i + 1}/${entries.length}] ${key} ... `);

      let albumId: string | null = null;

      if (overrides[key]) {
        albumId = albumIdFromOverride(overrides[key]);
        process.stdout.write("OVERRIDE ");
      } else {
        const found = await searchAlbum(tokens.access_token, artist, album);
        if (!found) {
          console.log("MISS");
          misses.push({ artist, album });
          continue;
        }
        albumId = found.id;
      }

      if (!albumId) {
        console.log("MISS");
        misses.push({ artist, album });
        continue;
      }

      const tracks = await getAlbumTracks(tokens.access_token, albumId);

      await addTracks(tokens.access_token, playlist.id, tracks);
      console.log(`OK (${tracks.length} tracks)`);
    }

    writeJson("misses.json", {
      generatedAt: new Date().toISOString(),
      playlistName,
      misses,
    });

    console.log("\nDone.");
  });
}

void main();
