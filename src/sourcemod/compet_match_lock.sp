#include <sourcemod>
#include <sdktools>
#include <cstrike>

#pragma semicolon 1
#pragma newdecls required

#define COMPET_STATUS_BUFFER_SIZE 8192
#define COMPET_STATUS_INTERVAL 30.0
#define COMPET_AUTH_SIZE 32
#define COMPET_PLAYER_NAME_SIZE 128
#define COMPET_TRADE_WINDOW_SECONDS 5.0

public Plugin myinfo = {
  name = "Compet Match Lock",
  author = "Compet",
  description = "Applies Compet match team locks before get5 is started.",
  version = "0.1.0",
  url = ""
};

StringMap g_PlayerTeams;
bool g_LockEnabled = false;
bool g_Get5Started = false;
bool g_StatsActive = false;
char g_MatchId[128] = "";
Handle g_EnforceTimer = null;
Handle g_StatusTimer = null;
int g_PlayerHeadshots[MAXPLAYERS + 1];
int g_PlayerRoundsPlayed[MAXPLAYERS + 1];
int g_PlayerKastRounds[MAXPLAYERS + 1];
int g_FirstHalfScoreT = 0;
int g_FirstHalfScoreCT = 0;
int g_SecondHalfScoreT = 0;
int g_SecondHalfScoreCT = 0;
int g_RegulationRoundsScored = 0;
char g_PlayerNames[MAXPLAYERS + 1][COMPET_PLAYER_NAME_SIZE];
char g_PlayerSteam64[MAXPLAYERS + 1][COMPET_AUTH_SIZE];
bool g_RoundStatsActive = false;
bool g_RoundParticipant[MAXPLAYERS + 1];
bool g_RoundKillOrAssist[MAXPLAYERS + 1];
bool g_RoundDied[MAXPLAYERS + 1];
bool g_RoundTraded[MAXPLAYERS + 1];
int g_RoundKiller[MAXPLAYERS + 1];
float g_RoundDeathTime[MAXPLAYERS + 1];

public void OnPluginStart() {
  g_PlayerTeams = new StringMap();
  RegServerCmd("compet_lock_reset", Command_ResetLock);
  RegServerCmd("compet_lock_add", Command_AddPlayer);
  RegServerCmd("compet_lock_enable", Command_EnableLock);
  AddCommandListener(Command_JoinTeam, "jointeam");
  AddCommandListener(Command_JoinTeam, "joingame");
  HookEvent("round_start", Event_RoundStart, EventHookMode_Post);
  HookEvent("round_end", Event_RoundEnd, EventHookMode_Post);
  HookEvent("player_death", Event_PlayerDeath, EventHookMode_Post);
  PrintToServer("[Compet] Match lock plugin loaded; waiting for compet_lock_reset.");
}

public void OnPluginEnd() {
  StopEnforceTimer();
  StopStatusTimer();
}

public void OnMapEnd() {
  WriteMatchStats();
  g_EnforceTimer = null;
}

public void OnClientPutInServer(int client) {
  CaptureClientIdentity(client);
}

public void OnClientPostAdminCheck(int client) {
  if (!g_LockEnabled || IsFakeClient(client)) {
    return;
  }
  CreateTimer(0.2, Timer_ApplyClientLock, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
}

public Action Command_ResetLock(int args) {
  g_PlayerTeams.Clear();
  g_LockEnabled = false;
  g_Get5Started = false;
  g_StatsActive = false;
  StopEnforceTimer();
  StopStatusTimer();
  g_MatchId[0] = '\0';
  if (args >= 1) {
    GetCmdArg(1, g_MatchId, sizeof(g_MatchId));
  }
  ResetMatchStats();
  ClearShutdownFlag();
  StartStatusTimer();
  return Plugin_Handled;
}

public Action Command_AddPlayer(int args) {
  if (args < 2) {
    PrintToServer("[Compet] Usage: compet_lock_add <steam64> <t|ct>");
    return Plugin_Handled;
  }
  char auth[32];
  char side[8];
  GetCmdArg(1, auth, sizeof(auth));
  GetCmdArg(2, side, sizeof(side));

  int team = SideToTeam(side);
  if (team == CS_TEAM_NONE) {
    PrintToServer("[Compet] Invalid side for %s: %s", auth, side);
    return Plugin_Handled;
  }

  g_PlayerTeams.SetValue(auth, team);
  return Plugin_Handled;
}

public Action Command_EnableLock(int args) {
  char enabled[8] = "1";
  if (args >= 1) {
    GetCmdArg(1, enabled, sizeof(enabled));
  }
  g_LockEnabled = !StrEqual(enabled, "0");
  if (g_LockEnabled) {
    StartEnforceTimer();
  } else {
    StopEnforceTimer();
  }
  for (int client = 1; client <= MaxClients; client++) {
    if (IsClientInGame(client) && !IsFakeClient(client)) {
      ApplyClientLock(client, false, CS_TEAM_NONE);
    }
  }
  PrintToServer("[Compet] Match lock %s for %s", g_LockEnabled ? "enabled" : "disabled", g_MatchId);
  return Plugin_Handled;
}

public void Get5_OnKnifeRoundStarted(Handle event) {
  MarkGet5Started("get5 knife round started");
}

public void Get5_OnGoingLive(Handle event) {
  MarkGet5Started("get5 going live");
  g_StatsActive = g_MatchId[0] != '\0';
  WriteMatchStats();
}

public Action Command_JoinTeam(int client, const char[] command, int argc) {
  if (!g_LockEnabled || client <= 0 || !IsClientInGame(client) || IsFakeClient(client)) {
    return Plugin_Continue;
  }

  int requestedTeam = RequestedTeamFromArgs(argc);
  return ApplyClientLock(client, true, requestedTeam) ? Plugin_Continue : Plugin_Stop;
}

public Action Timer_EnforceLocks(Handle timer, any data) {
  if (!g_LockEnabled) {
    g_EnforceTimer = null;
    return Plugin_Stop;
  }

  for (int client = 1; client <= MaxClients; client++) {
    if (IsClientInGame(client) && !IsFakeClient(client)) {
      ApplyClientLock(client, false, CS_TEAM_NONE);
    }
  }
  return Plugin_Continue;
}

public Action Timer_WriteStatus(Handle timer, any data) {
  if (g_MatchId[0] == '\0') {
    g_StatusTimer = null;
    return Plugin_Stop;
  }

  WriteStatusFiles();
  CheckShutdownFlag();
  return Plugin_Continue;
}

public Action Timer_ApplyClientLock(Handle timer, int userId) {
  int client = GetClientOfUserId(userId);
  if (client > 0 && IsClientInGame(client) && !IsFakeClient(client)) {
    ApplyClientLock(client, false, CS_TEAM_NONE);
  }
  return Plugin_Stop;
}

public void Event_RoundStart(Event event, const char[] name, bool dontBroadcast) {
  if (!ShouldRecordStats()) {
    return;
  }

  ResetRoundStats();
  g_RoundStatsActive = true;
  CaptureRoundParticipants();
}

public void Event_RoundEnd(Event event, const char[] name, bool dontBroadcast) {
  if (!ShouldRecordStats()) {
    return;
  }

  RecordHalfScore(event.GetInt("winner"));

  if (!g_RoundStatsActive) {
    CaptureRoundParticipants();
  }

  for (int client = 1; client <= MaxClients; client++) {
    if (!g_RoundParticipant[client]) {
      continue;
    }

    g_PlayerRoundsPlayed[client]++;
    if (g_RoundKillOrAssist[client] || !g_RoundDied[client] || g_RoundTraded[client]) {
      g_PlayerKastRounds[client]++;
    }
  }

  ResetRoundStats();
  WriteMatchStats();
}

public void Event_PlayerDeath(Event event, const char[] name, bool dontBroadcast) {
  if (!ShouldRecordStats()) {
    return;
  }

  int victim = GetClientOfUserId(event.GetInt("userid"));
  int attacker = GetClientOfUserId(event.GetInt("attacker"));
  int assister = GetClientOfUserId(event.GetInt("assister"));
  bool changed = false;

  if (IsStatsClient(victim)) {
    MarkRoundParticipant(victim);
    g_RoundDied[victim] = true;
    changed = true;
  }
  if (IsStatsClient(attacker) && IsStatsClient(victim) && attacker != victim && AreOpposingPlayers(attacker, victim)) {
    MarkRoundParticipant(attacker);
    if (event.GetBool("headshot")) {
      g_PlayerHeadshots[attacker]++;
    }
    g_RoundKillOrAssist[attacker] = true;
    g_RoundKiller[victim] = attacker;
    g_RoundDeathTime[victim] = GetGameTime();
    MarkTradedDeaths(attacker, victim);
    changed = true;
  }
  if (IsStatsClient(assister) && IsStatsClient(victim) && assister != victim && assister != attacker && AreOpposingPlayers(assister, victim)) {
    MarkRoundParticipant(assister);
    g_RoundKillOrAssist[assister] = true;
    changed = true;
  }
  if (changed) {
    WriteMatchStats();
  }
}

bool ApplyClientLock(int client, bool fromCommand, int requestedTeam) {
  char auth[32];
  if (!GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), true)) {
    return true;
  }

  int lockedTeam = CS_TEAM_NONE;
  if (!g_PlayerTeams.GetValue(auth, lockedTeam)) {
    KickClient(client, "You are not assigned to this Compet match.");
    return false;
  }

  if (IsPlayingTeam(requestedTeam) && requestedTeam != lockedTeam) {
    ChangeClientTeam(client, lockedTeam);
    return false;
  }

  int currentTeam = GetClientTeam(client);
  if (currentTeam != lockedTeam) {
    ChangeClientTeam(client, lockedTeam);
    return false;
  }

  return !fromCommand;
}

void MarkGet5Started(const char[] reason) {
  if (g_Get5Started || !g_LockEnabled || g_MatchId[0] == '\0') {
    return;
  }
  g_Get5Started = true;
  g_LockEnabled = false;
  StopEnforceTimer();
  PrintToServer("[Compet] %s; pre-get5 team lock disabled for match %s.", reason, g_MatchId);
}

void StartEnforceTimer() {
  if (g_EnforceTimer != null) {
    return;
  }
  g_EnforceTimer = CreateTimer(1.0, Timer_EnforceLocks, 0, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
}

void StartStatusTimer() {
  if (g_StatusTimer != null || g_MatchId[0] == '\0') {
    return;
  }
  WriteStatusFiles();
  g_StatusTimer = CreateTimer(COMPET_STATUS_INTERVAL, Timer_WriteStatus, 0, TIMER_REPEAT);
}

void StopEnforceTimer() {
  if (g_EnforceTimer == null) {
    return;
  }
  delete g_EnforceTimer;
  g_EnforceTimer = null;
}

void StopStatusTimer() {
  if (g_StatusTimer == null) {
    return;
  }
  delete g_StatusTimer;
  g_StatusTimer = null;
}

bool ShouldRecordStats() {
  return g_StatsActive && g_MatchId[0] != '\0';
}

void ResetMatchStats() {
  g_StatsActive = false;
  g_FirstHalfScoreT = 0;
  g_FirstHalfScoreCT = 0;
  g_SecondHalfScoreT = 0;
  g_SecondHalfScoreCT = 0;
  g_RegulationRoundsScored = 0;
  for (int client = 1; client <= MaxClients; client++) {
    g_PlayerHeadshots[client] = 0;
    g_PlayerRoundsPlayed[client] = 0;
    g_PlayerKastRounds[client] = 0;
    g_PlayerNames[client][0] = '\0';
    g_PlayerSteam64[client][0] = '\0';
  }
  ResetRoundStats();
  DeleteMatchStatsFile();
}

void ResetRoundStats() {
  g_RoundStatsActive = false;
  for (int client = 1; client <= MaxClients; client++) {
    g_RoundParticipant[client] = false;
    g_RoundKillOrAssist[client] = false;
    g_RoundDied[client] = false;
    g_RoundTraded[client] = false;
    g_RoundKiller[client] = 0;
    g_RoundDeathTime[client] = 0.0;
  }
}

void RecordHalfScore(int winner) {
  if (winner != CS_TEAM_T && winner != CS_TEAM_CT) {
    return;
  }
  if (g_RegulationRoundsScored >= 24) {
    return;
  }

  g_RegulationRoundsScored++;
  if (g_RegulationRoundsScored <= 12) {
    if (winner == CS_TEAM_T) {
      g_FirstHalfScoreT++;
    } else {
      g_FirstHalfScoreCT++;
    }
  } else if (winner == CS_TEAM_T) {
    g_SecondHalfScoreT++;
  } else {
    g_SecondHalfScoreCT++;
  }
}

void CaptureRoundParticipants() {
  for (int client = 1; client <= MaxClients; client++) {
    if (IsRoundParticipant(client)) {
      MarkRoundParticipant(client);
    }
  }
}

void MarkRoundParticipant(int client) {
  if (!IsRoundParticipant(client)) {
    return;
  }

  CaptureClientIdentity(client);
  g_RoundParticipant[client] = true;
  g_RoundStatsActive = true;
}

void MarkTradedDeaths(int attacker, int victim) {
  float now = GetGameTime();
  int attackerTeam = GetClientTeam(attacker);
  for (int client = 1; client <= MaxClients; client++) {
    if (!g_RoundDied[client] || g_RoundTraded[client] || g_RoundKiller[client] != victim) {
      continue;
    }
    if (GetClientTeam(client) != attackerTeam) {
      continue;
    }
    if (now - g_RoundDeathTime[client] <= COMPET_TRADE_WINDOW_SECONDS) {
      g_RoundTraded[client] = true;
    }
  }
}

void CaptureClientIdentity(int client) {
  if (!IsStatsClient(client)) {
    return;
  }

  GetClientName(client, g_PlayerNames[client], sizeof(g_PlayerNames[]));
  g_PlayerSteam64[client][0] = '\0';

  char auth[COMPET_AUTH_SIZE];
  auth[0] = '\0';
  if (GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), false) && !StrEqual(auth, "BOT", false)) {
    strcopy(g_PlayerSteam64[client], sizeof(g_PlayerSteam64[]), auth);
  }
}

bool IsStatsClient(int client) {
  return client > 0
    && client <= MaxClients
    && IsClientInGame(client)
    && !IsClientSourceTV(client)
    && !IsClientReplay(client);
}

bool IsRoundParticipant(int client) {
  return IsStatsClient(client) && IsPlayingTeam(GetClientTeam(client));
}

bool AreOpposingPlayers(int first, int second) {
  int firstTeam = GetClientTeam(first);
  int secondTeam = GetClientTeam(second);
  return IsPlayingTeam(firstTeam) && IsPlayingTeam(secondTeam) && firstTeam != secondTeam;
}

bool HasStoredMatchStats(int client) {
  return g_PlayerNames[client][0] != '\0'
    || g_PlayerSteam64[client][0] != '\0'
    || g_PlayerHeadshots[client] != 0
    || g_PlayerRoundsPlayed[client] != 0
    || g_PlayerKastRounds[client] != 0;
}

void BuildMatchStatsPath(char[] path, int maxlen) {
  char relative[PLATFORM_MAX_PATH];
  Format(relative, sizeof(relative), "data/compet/matches/%s/compet_matchstats.json", g_MatchId);
  BuildPath(Path_SM, path, maxlen, relative);
}

void DeleteMatchStatsFile() {
  if (g_MatchId[0] == '\0') {
    return;
  }

  char path[PLATFORM_MAX_PATH];
  BuildMatchStatsPath(path, sizeof(path));
  if (FileExists(path)) {
    DeleteFile(path);
  }
}

void WriteMatchStats() {
  if (g_MatchId[0] == '\0' || !EnsureCompetMatchDataDir()) {
    return;
  }

  int playerManager = FindEntityByClassname(-1, "cs_player_manager");
  if (playerManager == -1) {
    LogError("[Compet] Could not find cs_player_manager entity. Match stats were not written.");
    return;
  }

  char path[PLATFORM_MAX_PATH];
  BuildMatchStatsPath(path, sizeof(path));

  File file = OpenFile(path, "w");
  if (file == null) {
    PrintToServer("[Compet] Failed to open match stats file: %s", path);
    return;
  }

  char escapedMatchId[256];
  JsonEscape(g_MatchId, escapedMatchId, sizeof(escapedMatchId));

  WriteFileLine(file, "{");
  WriteFileLine(file, "  \"matchId\": \"%s\",", escapedMatchId);
  WriteFileLine(file, "  \"generatedAtUnix\": %d,", GetTime());
  WriteFileLine(file, "  \"firstHalfScore\":{\"t\":%d,\"ct\":%d},", g_FirstHalfScoreT, g_FirstHalfScoreCT);
  WriteFileLine(file, "  \"secondHalfScore\":{\"t\":%d,\"ct\":%d},", g_SecondHalfScoreT, g_SecondHalfScoreCT);
  WriteFileLine(file, "  \"players\": [");

  bool wroteAny = false;
  for (int client = 1; client <= MaxClients; client++) {
    if (IsStatsClient(client)) {
      CaptureClientIdentity(client);
    }
    if (!HasStoredMatchStats(client)) {
      continue;
    }

    int kills = GetEntProp(playerManager, Prop_Send, "m_iKills", _, client);
    int deaths = GetEntProp(playerManager, Prop_Send, "m_iDeaths", _, client);
    int assists = GetEntProp(playerManager, Prop_Send, "m_iAssists", _, client);
    int damage = GetEntProp(playerManager, Prop_Send, "m_iMatchStats_Damage_Total", _, client);

    char escapedName[256];
    char escapedSteam64[64];
    JsonEscape(g_PlayerNames[client], escapedName, sizeof(escapedName));
    JsonEscape(g_PlayerSteam64[client], escapedSteam64, sizeof(escapedSteam64));

    if (wroteAny) {
      WriteFileLine(
        file,
        "    ,{\"name\":\"%s\",\"steam64\":\"%s\",\"kills\":%d,\"deaths\":%d,\"assists\":%d,\"damage\":%d,\"headshots\":%d,\"kastRounds\":%d,\"roundsPlayed\":%d}",
        escapedName,
        escapedSteam64,
        kills,
        deaths,
        assists,
        damage,
        g_PlayerHeadshots[client],
        g_PlayerKastRounds[client],
        g_PlayerRoundsPlayed[client]
      );
    } else {
      WriteFileLine(
        file,
        "    {\"name\":\"%s\",\"steam64\":\"%s\",\"kills\":%d,\"deaths\":%d,\"assists\":%d,\"damage\":%d,\"headshots\":%d,\"kastRounds\":%d,\"roundsPlayed\":%d}",
        escapedName,
        escapedSteam64,
        kills,
        deaths,
        assists,
        damage,
        g_PlayerHeadshots[client],
        g_PlayerKastRounds[client],
        g_PlayerRoundsPlayed[client]
      );
      wroteAny = true;
    }
  }

  WriteFileLine(file, "  ]");
  WriteFileLine(file, "}");
  FlushFile(file);
  delete file;
}

void JsonEscape(const char[] input, char[] output, int maxlen) {
  int written = 0;
  for (int index = 0; input[index] != '\0' && written < maxlen - 1; index++) {
    if (input[index] == '"' || input[index] == '\\') {
      if (written >= maxlen - 2) {
        break;
      }
      output[written++] = '\\';
      output[written++] = input[index];
    } else if (input[index] == '\n' || input[index] == '\r' || input[index] == '\t') {
      output[written++] = ' ';
    } else {
      output[written++] = input[index];
    }
  }
  output[written] = '\0';
}

void WriteStatusFiles() {
  if (g_MatchId[0] == '\0' || !EnsureCompetDataDir()) {
    return;
  }

  int connectedCount = 0;
  int humanCount = 0;
  int botCount = 0;
  char humans[1024];
  humans[0] = '\0';

  for (int client = 1; client <= MaxClients; client++) {
    if (!IsClientConnected(client)) {
      continue;
    }
    connectedCount++;
    if (IsFakeClient(client) || IsClientSourceTV(client) || IsClientReplay(client)) {
      botCount++;
      continue;
    }
    if (!IsClientInGame(client)) {
      continue;
    }

    char auth[32];
    if (!GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), true)) {
      continue;
    }
    AppendHumanAuth(humans, sizeof(humans), auth, humanCount);
    humanCount++;
  }

  WriteJsonStatus(connectedCount, humanCount, botCount, humans);
  WriteConsoleStatus();
}

void AppendHumanAuth(char[] humans, int maxlen, const char[] auth, int index) {
  char piece[48];
  if (index > 0) {
    Format(piece, sizeof(piece), ",\"%s\"", auth);
  } else {
    Format(piece, sizeof(piece), "\"%s\"", auth);
  }
  StrCat(humans, maxlen, piece);
}

void WriteJsonStatus(int connectedCount, int humanCount, int botCount, const char[] humans) {
  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet/server_status.json");

  File file = OpenFile(path, "w");
  if (file == null) {
    PrintToServer("[Compet] Failed to open status file: %s", path);
    return;
  }

  WriteFileLine(file, "{");
  WriteFileLine(file, "  \"matchId\": \"%s\",", g_MatchId);
  WriteFileLine(file, "  \"generatedAtUnix\": %d,", GetTime());
  WriteFileLine(file, "  \"connectedCount\": %d,", connectedCount);
  WriteFileLine(file, "  \"humanCount\": %d,", humanCount);
  WriteFileLine(file, "  \"botCount\": %d,", botCount);
  WriteFileLine(file, "  \"humans\": [%s],", humans);
  WriteFileLine(file, "  \"lockEnabled\": %s,", g_LockEnabled ? "true" : "false");
  WriteFileLine(file, "  \"get5Started\": %s", g_Get5Started ? "true" : "false");
  WriteFileLine(file, "}");
  FlushFile(file);
  delete file;
}

void WriteConsoleStatus() {
  char output[COMPET_STATUS_BUFFER_SIZE];
  output[0] = '\0';
  ServerCommandEx(output, sizeof(output), "status");

  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet/server_status.txt");

  File file = OpenFile(path, "w");
  if (file == null) {
    PrintToServer("[Compet] Failed to open console status file: %s", path);
    return;
  }

  WriteFileString(file, output, false);
  FlushFile(file);
  delete file;
}

void CheckShutdownFlag() {
  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet/shutdown.flag");
  if (!FileExists(path)) {
    return;
  }

  char requestedMatchId[128];
  requestedMatchId[0] = '\0';
  File file = OpenFile(path, "r");
  if (file != null) {
    ReadFileLine(file, requestedMatchId, sizeof(requestedMatchId));
    delete file;
  }
  DeleteFile(path);
  TrimString(requestedMatchId);

  if (g_MatchId[0] == '\0' || !StrEqual(requestedMatchId, g_MatchId)) {
    PrintToServer("[Compet] Ignored shutdown flag for %s while running %s.", requestedMatchId, g_MatchId);
    return;
  }

  PrintToServer("[Compet] Empty server shutdown requested for match %s.", g_MatchId);
  ServerCommand("quit");
}

void ClearShutdownFlag() {
  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet/shutdown.flag");
  if (FileExists(path)) {
    DeleteFile(path);
  }
}

bool EnsureCompetDataDir() {
  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet");
  return DirExists(path) || CreateDirectory(path);
}

bool EnsureCompetMatchDataDir() {
  if (!EnsureCompetDataDir()) {
    return false;
  }

  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet/matches");
  if (!DirExists(path) && !CreateDirectory(path)) {
    return false;
  }

  char relative[PLATFORM_MAX_PATH];
  Format(relative, sizeof(relative), "data/compet/matches/%s", g_MatchId);
  BuildPath(Path_SM, path, sizeof(path), relative);
  return DirExists(path) || CreateDirectory(path);
}

bool IsPlayingTeam(int team) {
  return team == CS_TEAM_T || team == CS_TEAM_CT;
}

int RequestedTeamFromArgs(int argc) {
  if (argc < 1) {
    return CS_TEAM_NONE;
  }

  char arg[16];
  GetCmdArg(1, arg, sizeof(arg));
  return SideToTeam(arg);
}

int SideToTeam(const char[] side) {
  if (StrEqual(side, "t", false) || StrEqual(side, "2")) {
    return CS_TEAM_T;
  }
  if (StrEqual(side, "ct", false) || StrEqual(side, "3")) {
    return CS_TEAM_CT;
  }
  return CS_TEAM_NONE;
}
