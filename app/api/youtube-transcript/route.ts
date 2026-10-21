import { NextRequest, NextResponse } from 'next/server';
import { parseTimedTextXml, TranscriptTrackInfo } from '../../transcript';

const YOUTUBE_VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

// Caption URLs from the web player now require a proof-of-origin token, but
// the Android client's player response still returns directly fetchable ones.
// If YouTube changes this, the page falls back to uploading a subtitle file.
const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const ANDROID_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38' };

type CaptionTrack = {
  baseUrl?: unknown;
  languageCode?: unknown;
  kind?: unknown;
  name?: { simpleText?: unknown; runs?: { text?: unknown }[] };
};

function trackInfo(track: CaptionTrack): TranscriptTrackInfo {
  const name =
    typeof track.name?.simpleText === 'string'
      ? track.name.simpleText
      : (track.name?.runs ?? []).map((run) => (typeof run.text === 'string' ? run.text : '')).join('');
  return {
    languageCode: typeof track.languageCode === 'string' ? track.languageCode : 'unknown',
    name: name || String(track.languageCode ?? 'Unknown'),
    kind: track.kind === 'asr' ? 'auto-generated' : 'uploaded',
  };
}

// Prefer the requested language, and human-uploaded captions over auto-generated ones.
function chooseTrack(tracks: CaptionTrack[], language: string) {
  const matches = (track: CaptionTrack) =>
    typeof track.languageCode === 'string' &&
    (track.languageCode === language || track.languageCode.startsWith(`${language}-`));
  return (
    tracks.find((track) => matches(track) && track.kind !== 'asr') ??
    tracks.find((track) => matches(track)) ??
    tracks.find((track) => track.kind !== 'asr') ??
    tracks[0]
  );
}

function failure(code: string, message: string, status: number, availableTracks: TranscriptTrackInfo[] = []) {
  return NextResponse.json({ ok: false, error: { code, message }, availableTracks }, { status });
}

export async function GET(request: NextRequest) {
  const videoId = request.nextUrl.searchParams.get('videoId');
  if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) {
    return failure('INVALID_VIDEO', 'Invalid YouTube video ID.', 400);
  }
  const language = request.nextUrl.searchParams.get('lang')?.trim() || 'en';

  let playerResponse: {
    playabilityStatus?: { status?: unknown };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
  };
  try {
    const response = await fetch(INNERTUBE_PLAYER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId }),
    });
    if (!response.ok) throw new Error(`player ${response.status}`);
    playerResponse = await response.json();
  } catch {
    return failure('YOUTUBE_UNREACHABLE', 'YouTube did not return caption information.', 502);
  }

  const tracks = (playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).filter(
    (track) => typeof track.baseUrl === 'string',
  );
  const availableTracks = tracks.map(trackInfo);
  if (tracks.length === 0) {
    const playable = playerResponse.playabilityStatus?.status === 'OK';
    return failure(
      playable ? 'NO_CAPTIONS' : 'CAPTIONS_UNAVAILABLE',
      playable
        ? 'This video has no captions.'
        : 'YouTube did not provide captions for this video (it may be private, age-restricted, or blocked).',
      404,
    );
  }

  const track = chooseTrack(tracks, language);
  const captionUrl = new URL(track.baseUrl as string);
  if (captionUrl.hostname !== 'www.youtube.com' || captionUrl.pathname !== '/api/timedtext') {
    return failure('CAPTIONS_UNAVAILABLE', 'YouTube returned an unexpected caption address.', 502, availableTracks);
  }

  let cues;
  try {
    const response = await fetch(captionUrl);
    if (!response.ok) throw new Error(`timedtext ${response.status}`);
    cues = parseTimedTextXml(await response.text());
  } catch {
    return failure('CAPTIONS_UNAVAILABLE', 'YouTube would not send the caption text.', 502, availableTracks);
  }
  if (cues.length === 0) {
    return failure('CAPTIONS_UNAVAILABLE', 'The caption track was empty.', 502, availableTracks);
  }

  return NextResponse.json(
    { ok: true, videoId, track: trackInfo(track), availableTracks, cues },
    { headers: { 'Cache-Control': 'private, max-age=3600' } },
  );
}
