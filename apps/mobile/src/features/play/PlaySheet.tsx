import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { PlayRequest } from "../../core/playback/request";
import {
  formatSize,
  formatTime,
  GROUP_NAMES,
  label,
  readinessText,
  type PlaySource,
  type PlayTitle,
  type ResumePoint,
} from "../../core/services/playback";
import { useCanFindReleases } from "../../lib/plugins";
import { useStore } from "../../state/hooks";
import { openPlayer, openReleases } from "../../state/navigation";
import { usePlayRequest } from "../../state/playback";
import { Button, IconButton, Loading, Message } from "../../ui/components";
import { Press } from "../../ui/press";
import { color, font, radius, space, text } from "../../ui/theme";

// Play: every way the server has to play this movie or episode, grouped by
// kind with the best first (core/playback/request.ts). Nothing starts until a
// tap: resuming offers the release the profile was watching, from where it
// stopped, or from the beginning. The server's own pick is marked "Best match".

type Params = { title: string; resume?: string };

export default function PlaySheet() {
  const params = useLocalSearchParams<Params>();
  const [title] = useState(() => JSON.parse(params.title) as PlayTitle);
  const [resume] = useState(() =>
    params.resume ? (JSON.parse(params.resume) as ResumePoint) : null,
  );
  const request = usePlayRequest(title, resume);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.sheet, { paddingTop: insets.top }]}>
      <View style={styles.heading}>
        <View style={{ flex: 1 }}>
          <Text style={text.title} numberOfLines={1}>
            {label(title)}
          </Text>
          {title.episodeName ? (
            <Text style={text.small}>{title.episodeName}</Text>
          ) : null}
        </View>
        <IconButton
          icon="chevron-down"
          label="Close"
          glass
          onPress={() => router.back()}
        />
      </View>
      <Sources request={request} bottom={insets.bottom} />
    </View>
  );
}

function Sources({
  request,
  bottom,
}: {
  request: PlayRequest;
  bottom: number;
}) {
  const state = useStore(request.state);
  const { sources } = state;
  const canFind = useCanFindReleases();

  async function play(
    source: PlaySource,
    choice: { resume?: boolean; confirmed?: boolean } = {},
  ) {
    const started = await request.choose(source, choice);
    if (started) openPlayer(started.sessionId);
  }

  if (sources.kind === "loading")
    return <Loading label="Looking for ways to play it…" />;
  if (sources.kind === "failed")
    return (
      <Message
        title="The sources didn’t load"
        body={sources.message}
        action={{ label: "Try again", onPress: () => request.reload() }}
      />
    );

  const { answer } = sources;
  const byId = new Map(answer.sources.map((s) => [s.id, s]));
  const resumed = request.resumedSource();
  const busy = state.starting != null;

  return (
    <ScrollView
      contentContainerStyle={{
        padding: space.l,
        paddingBottom: bottom + space.xxl,
      }}
    >
      {request.resume && resumed ? (
        <View style={styles.resume}>
          <Text style={styles.resumeKicker}>
            You stopped at {formatTime(request.resume.positionS)}
          </Text>
          <Text
            style={[text.small, { color: color.textSecondary }]}
            numberOfLines={2}
          >
            {resumed.label}
          </Text>
          <View style={styles.resumeActions}>
            <Button
              icon="play"
              label={state.starting === resumed.id ? "Starting…" : "Resume"}
              disabled={busy}
              onPress={() => void play(resumed, { resume: true })}
              style={{ flex: 1 }}
            />
            <Button
              kind="secondary"
              icon="refresh"
              label="From the start"
              disabled={busy}
              onPress={() => void play(resumed)}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : null}
      {request.resume && !resumed ? (
        <Text style={[text.small, styles.gone]}>
          The release you were watching isn’t offered any more: choose another
          one.
        </Text>
      ) : null}

      {state.question ? (
        <View style={styles.notice}>
          <Text style={text.body}>{state.question.question}</Text>
          <Text style={text.tiny}>{state.question.by}</Text>
          <View style={styles.row}>
            <Button
              kind="secondary"
              label={state.question.no}
              onPress={() => request.dismissQuestion()}
            />
            <Button
              label={state.question.yes}
              onPress={() =>
                void play(state.question!.source, { confirmed: true })
              }
            />
          </View>
        </View>
      ) : null}
      {state.refusal ? (
        <View style={styles.notice}>
          <Text style={text.body}>{state.refusal.reason}</Text>
          <Text style={text.tiny}>{state.refusal.by}</Text>
        </View>
      ) : null}
      {state.error ? (
        <Text
          style={[text.body, { color: color.error, marginBottom: space.m }]}
        >
          {state.error}
        </Text>
      ) : null}

      {!answer.groups.length ? (
        <Message
          title="Nothing to play this from yet"
          body="Sources come from the server: files in its library, and the plugins its admin installs on the dashboard."
        />
      ) : null}

      {answer.groups.map((group) => {
        const list = answer.sources.filter((s) => s.group === group.group);
        const best = byId.get(group.best);
        const ordered = [
          best,
          ...list.filter((s) => s.id !== group.best),
        ].filter((s): s is PlaySource => !!s);
        return (
          <View key={group.group} style={{ marginBottom: space.xl }}>
            <Text style={[text.heading, styles.groupName]}>
              {GROUP_NAMES[group.group] ?? group.group}
            </Text>
            {ordered.map((source, i) => (
              <SourceRow
                key={source.id}
                source={source}
                first={i === 0}
                bestMatch={source.id === answer.policy.autoplay}
                busy={state.starting === source.id}
                disabled={busy}
                onPress={() => void play(source)}
              />
            ))}
          </View>
        );
      })}

      {answer.hidden.map((h) => (
        <Text key={h.id} style={[text.tiny, { marginTop: space.xs }]}>
          Hidden by {h.by}: {h.reason}
        </Text>
      ))}
      {canFind ? (
        <Press
          onPress={() => openReleases({ title: request.title })}
          scale={0.98}
          style={styles.more}
          accessibilityRole="button"
        >
          <Ionicons name="search" size={20} color={color.accent} />
          <View style={{ flex: 1 }}>
            <Text style={text.label}>Search more sources</Text>
            <Text style={text.small}>
              Every torrent and stream provider of the server, with your own
              words
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={color.textDim} />
        </Press>
      ) : null}
      {answer.errors.length ? (
        <Text style={[text.tiny, { marginTop: space.m }]}>
          {answer.errors.length} source{answer.errors.length > 1 ? "s" : ""}{" "}
          didn’t answer.
        </Text>
      ) : null}
    </ScrollView>
  );
}

function SourceRow({
  source,
  first,
  bestMatch,
  busy,
  disabled,
  onPress,
}: {
  source: PlaySource;
  first: boolean;
  bestMatch: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const facts = [
    source.quality,
    formatSize(source.size),
    source.seeds != null ? `${source.seeds} seeds` : null,
    source.resolver
      ? `Cached on ${source.resolver.label}`
      : source.tryResolver
        ? `${source.tryResolver.label} tries it first`
        : null,
    source.progress != null && source.progress < 1
      ? `${Math.round(source.progress * 100)} % downloaded`
      : null,
  ].filter(Boolean);
  const warn = source.playable === "no" || source.playable === "maybe";
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      scale={0.98}
      style={[
        styles.source,
        first && styles.sourceFirst,
        disabled && !busy && { opacity: 0.5 },
      ]}
      accessibilityLabel={source.label}
    >
      <Ionicons
        name={
          busy
            ? "hourglass-outline"
            : source.type === "torrent"
              ? "magnet-outline"
              : "play-circle-outline"
        }
        size={26}
        color={first ? color.accent : color.text}
      />
      <View style={{ flex: 1 }}>
        <View style={styles.sourceHead}>
          {bestMatch ? <Text style={styles.best}>Best match</Text> : null}
          {first && source.readiness ? (
            <Text style={[text.tiny, { color: color.live }]}>
              {readinessText(source.readiness)}
            </Text>
          ) : null}
        </View>
        <Text style={[text.label, { fontSize: 15 }]} numberOfLines={2}>
          {busy ? "Starting…" : source.label}
        </Text>
        {facts.length ? (
          <Text style={text.tiny}>{facts.join(", ")}</Text>
        ) : null}
        {source.notes.length ? (
          <Text style={[text.tiny, warn && { color: color.caution }]}>
            {source.notes.join(" ")}
          </Text>
        ) : null}
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: color.surface2 },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.m,
    padding: space.l,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  resume: {
    padding: space.l,
    borderRadius: radius.l,
    backgroundColor: color.surface3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentDeep,
    marginBottom: space.xl,
    gap: space.s,
  },
  resumeKicker: { fontFamily: font.display, fontSize: 18, color: color.accent },
  resumeActions: { flexDirection: "row", gap: space.m, marginTop: space.s },
  gone: { color: color.caution, marginBottom: space.l },
  groupName: { marginBottom: space.s },
  source: {
    flexDirection: "row",
    gap: space.m,
    padding: space.m,
    borderRadius: radius.m,
    backgroundColor: color.surface1,
    marginBottom: space.s,
  },
  sourceFirst: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  sourceHead: { flexDirection: "row", gap: space.s, alignItems: "center" },
  best: {
    ...text.tiny,
    color: color.onAccent,
    backgroundColor: color.accent,
    paddingHorizontal: 6,
    borderRadius: radius.s,
    overflow: "hidden",
  },
  more: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.m,
    padding: space.l,
    borderRadius: radius.m,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    marginTop: space.s,
  },
  notice: {
    padding: space.l,
    borderRadius: radius.m,
    backgroundColor: color.surface3,
    marginBottom: space.l,
    gap: space.s,
  },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: space.s },
});
