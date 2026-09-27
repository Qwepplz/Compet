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
#define COMPET_RECORD_KEY_SIZE 192

public Plugin myinfo = {
  name = "Compet Match Lock",
  author = "Compet",
  description = "Applies Compet match team locks before get5 is started.",
  version = "0.1.0",
  url = ""
};

enum struct MatchPlayerStats {
  char key[COMPET_RECORD_KEY_SIZE];
  char name[COMPET_PLAYER_NAME_SIZE];
  char steam64[COMPET_AUTH_SIZE];
  bool bot;
  bool ambiguousBotName;
  int kills;
  int nativeDeaths;
  int pendingDeaths;
  int assists;
  int damage;
  int pendingKills;
  int pendingAssists;
  int headshots;
  int kastRounds;
  int roundsPlayed;
  int lastNativeSerial;
  int disconnects;
  bool roundParticipant;
  bool roundKillOrAssist;
  bool roundDied;
  bool roundTraded;
  bool roundAlive;
  int roundTeam;
  int roundKiller;
  float roundDeathTime;
}

StringMap g_PlayerTeams;
StringMap g_RecordIndex;
ArrayList g_PlayerRecords;
bool g_LockEnabled = false;
bool g_Get5Started = false;
bool g_StatsActive = false;
bool g_MatchFinalized = false;
char g_MatchId[128] = "";
Handle g_EnforceTimer = null;
Handle g_StatusTimer = null;
int g_ClientRecord[MAXPLAYERS + 1];
int g_ClientSerial[MAXPLAYERS + 1];
bool g_ClientAdmitted[MAXPLAYERS + 1];
bool g_ClientRejected[MAXPLAYERS + 1];
int g_RoundNumber = 0;
bool g_RoundSettled = true;
int g_FirstHalfScoreT = 0;
int g_FirstHalfScoreCT = 0;
int g_SecondHalfScoreT = 0;
int g_SecondHalfScoreCT = 0;
int g_RegulationRoundsScored = 0;

public void OnPluginStart() {
  g_PlayerTeams = new StringMap();
  g_RecordIndex = new StringMap();
  g_PlayerRecords = new ArrayList(sizeof(MatchPlayerStats));
  for (int client = 1; client <= MaxClients; client++) {
    g_ClientRecord[client] = -1;
  }
  RegServerCmd("compet_lock_reset", Command_ResetLock);
  RegServerCmd("compet_lock_add", Command_AddPlayer);
  RegServerCmd("compet_lock_enable", Command_EnableLock);
  AddCommandListener(Command_JoinTeam, "jointeam");
  AddCommandListener(Command_JoinTeam, "joingame");
  HookEvent("round_start", Event_RoundStart, EventHookMode_Post);
  HookEvent("round_end", Event_RoundEnd, EventHookMode_Post);
  HookEvent("player_hurt", Event_PlayerHurt, EventHookMode_Post);
  HookEvent("player_death", Event_PlayerDeath, EventHookMode_Post);
  HookEvent("player_spawn", Event_PlayerSpawn, EventHookMode_Post);
  PrintToServer("[Compet] Match lock plugin loaded; waiting for compet_lock_reset.");
}

public void OnPluginEnd() {
  StopEnforceTimer();
  StopStatusTimer();
  delete g_PlayerRecords;
  delete g_RecordIndex;
  delete g_PlayerTeams;
}

public void OnMapEnd() {
  if (!g_MatchFinalized) {
    RefreshAllNativeStats();
  }
  WriteMatchStats();
  g_EnforceTimer = null;
}

public void OnClientPutInServer(int client) {
  g_ClientRecord[client] = -1;
  g_ClientSerial[client] = 0;
  g_ClientAdmitted[client] = false;
  g_ClientRejected[client] = false;
  if (IsFakeClient(client)) {
    EnsurePlayerRecord(client);
  }
}

public void OnClientDisconnect(int client) {
  RecordDisconnect(client);
}

public void OnClientDisconnect_Post(int client) {
  g_ClientRejected[client] = false;
  WriteStatusFiles();
}

public void OnClientPostAdminCheck(int client) {
  if (g_MatchId[0] != '\0') {
    if (!IsFakeClient(client) && CheckReconnectLimit(client)) {
      return;
    }
    int record = EnsurePlayerRecord(client);
    if (record != -1) {
      if (!IsFakeClient(client)) {
        char auth[COMPET_AUTH_SIZE];
        int team = CS_TEAM_NONE;
        if (GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), true)
            && g_PlayerTeams.GetValue(auth, team)) {
          g_ClientAdmitted[client] = true;
        }
      }
      RequestFrame(Frame_RefreshNativeStats, GetClientSerial(client));
    }
  }
  if (g_LockEnabled && !IsFakeClient(client)) {
    CreateTimer(0.2, Timer_ApplyClientLock, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
  }
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
  g_StatsActive = g_MatchId[0] != '\0' && !g_MatchFinalized;
  RefreshAllNativeStats();
  WriteMatchStats();
}

public void Get5_OnSeriesResult(Handle event) {
  FinalizeMatchStats();
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
    WriteStatusFiles();
  }
  return Plugin_Stop;
}

public void Event_RoundStart(Event event, const char[] name, bool dontBroadcast) {
  if (!ShouldRecordStats()) {
    return;
  }
  g_RoundNumber++;
  ResetRoundStats();
  g_RoundSettled = false;
  CaptureRoundParticipants();
}

public void Event_RoundEnd(Event event, const char[] name, bool dontBroadcast) {
  if (!ShouldRecordStats()) {
    return;
  }
  if (g_RoundNumber == 0) {
    g_RoundNumber = 1;
    ResetRoundStats();
    g_RoundSettled = false;
    CaptureRoundParticipants();
  }
  if (g_RoundSettled) {
    return;
  }
  RecordHalfScore(event.GetInt("winner"));
  SettleRoundStats();
  WriteMatchStats();
}

public void Event_PlayerSpawn(Event event, const char[] name, bool dontBroadcast) {
  if (!ShouldRecordStats() || g_RoundSettled) {
    return;
  }
  int client = GetClientOfUserId(event.GetInt("userid"));
  int record = MarkRoundParticipant(client);
  if (record == -1) {
    return;
  }
  MatchPlayerStats stats;
  g_PlayerRecords.GetArray(record, stats, sizeof(stats));
  stats.roundAlive = true;
  g_PlayerRecords.SetArray(record, stats, sizeof(stats));
}

public void Event_PlayerHurt(Event event, const char[] name, bool dontBroadcast) {
  if (!ShouldRecordStats()) {
    return;
  }
  int attacker = GetClientOfUserId(event.GetInt("attacker"));
  int victim = GetClientOfUserId(event.GetInt("userid"));
  int attackerRecord = EnsurePlayerRecord(attacker);
  if (attackerRecord != -1) {
    RefreshNativeStats(attacker, attackerRecord);
    RequestFrame(Frame_RefreshNativeStats, GetClientSerial(attacker));
  }
  if (victim != attacker) {
    int victimRecord = EnsurePlayerRecord(victim);
    if (victimRecord != -1) {
      RefreshNativeStats(victim, victimRecord);
      RequestFrame(Frame_RefreshNativeStats, GetClientSerial(victim));
    }
  }
}

public void Event_PlayerDeath(Event event, const char[] name, bool dontBroadcast) {
  if (!ShouldRecordStats()) {
    return;
  }

  int victim = GetClientOfUserId(event.GetInt("userid"));
  int attacker = GetClientOfUserId(event.GetInt("attacker"));
  int assister = GetClientOfUserId(event.GetInt("assister"));
  int victimRecord = EnsurePlayerRecord(victim);
  int attackerRecord = EnsurePlayerRecord(attacker);
  int assisterRecord = EnsurePlayerRecord(assister);
  bool changed = false;

  if (victimRecord != -1) {
    MarkRoundParticipant(victim);
    MatchPlayerStats victimStats;
    g_PlayerRecords.GetArray(victimRecord, victimStats, sizeof(victimStats));
    bool firstDeath = !victimStats.roundDied;
    victimStats.roundDied = true;
    victimStats.roundAlive = false;
    g_PlayerRecords.SetArray(victimRecord, victimStats, sizeof(victimStats));
    if (firstDeath) {
      RecordNativeStatEvent(victim, victimRecord, 1);
    } else {
      RefreshNativeStats(victim, victimRecord);
    }
    changed = true;
  }
  if (attackerRecord != -1 && victimRecord != -1 && attacker != victim && AreOpposingPlayers(attacker, victim)) {
    MarkRoundParticipant(attacker);
    MatchPlayerStats attackerStats;
    g_PlayerRecords.GetArray(attackerRecord, attackerStats, sizeof(attackerStats));
    if (event.GetBool("headshot")) {
      attackerStats.headshots++;
    }
    attackerStats.roundKillOrAssist = true;
    g_PlayerRecords.SetArray(attackerRecord, attackerStats, sizeof(attackerStats));
    RecordNativeStatEvent(attacker, attackerRecord, 0);

    MatchPlayerStats victimStats;
    g_PlayerRecords.GetArray(victimRecord, victimStats, sizeof(victimStats));
    victimStats.roundKiller = attackerRecord;
    victimStats.roundDeathTime = GetGameTime();
    g_PlayerRecords.SetArray(victimRecord, victimStats, sizeof(victimStats));
    MarkTradedDeaths(victimRecord, GetClientTeam(attacker));
    changed = true;
  }
  if (assisterRecord != -1 && victimRecord != -1 && assister != victim && assister != attacker && AreOpposingPlayers(assister, victim)) {
    MarkRoundParticipant(assister);
    MatchPlayerStats assisterStats;
    g_PlayerRecords.GetArray(assisterRecord, assisterStats, sizeof(assisterStats));
    assisterStats.roundKillOrAssist = true;
    g_PlayerRecords.SetArray(assisterRecord, assisterStats, sizeof(assisterStats));
    RecordNativeStatEvent(assister, assisterRecord, 2);
    changed = true;
  }
  if (changed) {
    WriteMatchStats();
  }
}

bool CheckReconnectLimit(int client) {
  if (g_MatchId[0] == '\0' || g_MatchFinalized || !IsStatsClient(client) || IsFakeClient(client)) {
    return false;
  }
  char auth[COMPET_AUTH_SIZE];
  int team = CS_TEAM_NONE;
  if (!GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), true)
      || !g_PlayerTeams.GetValue(auth, team)) {
    return false;
  }
  char key[COMPET_RECORD_KEY_SIZE];
  Format(key, sizeof(key), "human:%s", auth);
  int record = -1;
  if (!g_RecordIndex.GetValue(key, record)) {
    return false;
  }
  MatchPlayerStats stats;
  g_PlayerRecords.GetArray(record, stats, sizeof(stats));
  if (stats.disconnects >= 5) {
    g_ClientRejected[client] = true;
    KickClient(client, "Reconnect denied: disconnect limit reached for this match.");
    return true;
  }
  return false;
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
  return g_StatsActive && !g_MatchFinalized && g_MatchId[0] != '\0';
}

void FinalizeMatchStats() {
  if (g_MatchFinalized || g_MatchId[0] == '\0') {
    return;
  }
  if (g_RoundSettled) {
    RefreshAllNativeStats();
  } else {
    SettleRoundStats();
  }
  WriteMatchStats();
  g_MatchFinalized = true;
  g_StatsActive = false;
}

void ResetMatchStats() {
  g_StatsActive = false;
  g_MatchFinalized = false;
  g_RoundNumber = 0;
  g_RoundSettled = true;
  g_FirstHalfScoreT = 0;
  g_FirstHalfScoreCT = 0;
  g_SecondHalfScoreT = 0;
  g_SecondHalfScoreCT = 0;
  g_RegulationRoundsScored = 0;
  g_RecordIndex.Clear();
  g_PlayerRecords.Clear();
  for (int client = 1; client <= MaxClients; client++) {
    g_ClientRecord[client] = -1;
    g_ClientSerial[client] = 0;
    g_ClientAdmitted[client] = false;
    g_ClientRejected[client] = false;
  }
  DeleteMatchStatsFile();
}

void ResetRoundStats() {
  for (int record = 0; record < g_PlayerRecords.Length; record++) {
    MatchPlayerStats stats;
    g_PlayerRecords.GetArray(record, stats, sizeof(stats));
    stats.roundParticipant = false;
    stats.roundKillOrAssist = false;
    stats.roundDied = false;
    stats.roundTraded = false;
    stats.roundAlive = false;
    stats.roundTeam = CS_TEAM_NONE;
    stats.roundKiller = -1;
    stats.roundDeathTime = 0.0;
    g_PlayerRecords.SetArray(record, stats, sizeof(stats));
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

int MarkRoundParticipant(int client) {
  if (!IsRoundParticipant(client)) {
    return -1;
  }
  int record = EnsurePlayerRecord(client);
  if (record == -1 || g_RoundSettled) {
    return record;
  }
  MatchPlayerStats stats;
  g_PlayerRecords.GetArray(record, stats, sizeof(stats));
  stats.roundParticipant = true;
  stats.roundTeam = GetClientTeam(client);
  if (!stats.roundDied) {
    stats.roundAlive = IsPlayerAlive(client);
  }
  g_PlayerRecords.SetArray(record, stats, sizeof(stats));
  return record;
}

void SettleRoundStats() {
  if (g_RoundSettled) {
    return;
  }
  RefreshAllNativeStats();
  for (int record = 0; record < g_PlayerRecords.Length; record++) {
    MatchPlayerStats stats;
    g_PlayerRecords.GetArray(record, stats, sizeof(stats));
    if (!stats.roundParticipant) {
      continue;
    }
    stats.roundsPlayed++;
    if (stats.roundKillOrAssist || !stats.roundDied || stats.roundTraded) {
      stats.kastRounds++;
    }
    g_PlayerRecords.SetArray(record, stats, sizeof(stats));
  }
  g_RoundSettled = true;
}

void MarkTradedDeaths(int victimRecord, int attackerTeam) {
  float now = GetGameTime();
  for (int record = 0; record < g_PlayerRecords.Length; record++) {
    MatchPlayerStats stats;
    g_PlayerRecords.GetArray(record, stats, sizeof(stats));
    if (!stats.roundDied || stats.roundTraded || stats.roundKiller != victimRecord || stats.roundTeam != attackerTeam) {
      continue;
    }
    if (now - stats.roundDeathTime <= COMPET_TRADE_WINDOW_SECONDS) {
      stats.roundTraded = true;
      g_PlayerRecords.SetArray(record, stats, sizeof(stats));
    }
  }
}

bool IsSteam64(const char[] auth) {
  if (strlen(auth) != 17) {
    return false;
  }
  for (int index = 0; index < 17; index++) {
    if (auth[index] < '0' || auth[index] > '9') {
      return false;
    }
  }
  return true;
}

bool IsRecordBoundToOtherClient(int record, int client) {
  for (int other = 1; other <= MaxClients; other++) {
    if (other != client && g_ClientRecord[other] == record && g_ClientSerial[other] != 0
        && GetClientFromSerial(g_ClientSerial[other]) == other) {
      return true;
    }
  }
  return false;
}

int EnsurePlayerRecord(int client) {
  if (g_MatchId[0] == '\0' || !IsStatsClient(client)) {
    return -1;
  }
  int serial = GetClientSerial(client);
  if (g_ClientRecord[client] != -1 && g_ClientSerial[client] == serial) {
    return g_ClientRecord[client];
  }

  char name[COMPET_PLAYER_NAME_SIZE];
  char auth[COMPET_AUTH_SIZE];
  char key[COMPET_RECORD_KEY_SIZE];
  GetClientName(client, name, sizeof(name));
  auth[0] = '\0';
  bool bot = IsFakeClient(client);
  bool stableBotAuth = false;
  if (bot) {
    stableBotAuth = GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), false) && IsSteam64(auth);
    if (stableBotAuth) {
      Format(key, sizeof(key), "bot-auth:%s", auth);
    } else {
      auth[0] = '\0';
      Format(key, sizeof(key), "bot-name:%s", name);
    }
  } else {
    if (!GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), true) || !IsSteam64(auth)) {
      return -1;
    }
    Format(key, sizeof(key), "human:%s", auth);
  }

  int record = -1;
  bool found = g_RecordIndex.GetValue(key, record);
  if (bot && !stableBotAuth && found) {
    MatchPlayerStats existing;
    g_PlayerRecords.GetArray(record, existing, sizeof(existing));
    if (existing.ambiguousBotName || IsRecordBoundToOtherClient(record, client)) {
      existing.ambiguousBotName = true;
      g_PlayerRecords.SetArray(record, existing, sizeof(existing));
      LogError("[Compet] Ambiguous BOT name %s in match %s; keeping separate records.", name, g_MatchId);
      found = false;
      Format(key, sizeof(key), "bot-name:%s#%d", name, serial);
    }
  }

  if (!found) {
    if (bot) {
      for (int other = 0; other < g_PlayerRecords.Length; other++) {
        MatchPlayerStats existing;
        g_PlayerRecords.GetArray(other, existing, sizeof(existing));
        if (existing.bot && StrEqual(existing.name, name) && !StrEqual(existing.key, key)) {
          LogError("[Compet] BOT name collision %s in match %s; identities remain separate.", name, g_MatchId);
          if (!stableBotAuth) {
            Format(key, sizeof(key), "bot-name:%s#%d", name, serial);
          }
          break;
        }
      }
    }
    MatchPlayerStats stats;
    strcopy(stats.key, sizeof(stats.key), key);
    strcopy(stats.name, sizeof(stats.name), name);
    strcopy(stats.steam64, sizeof(stats.steam64), auth);
    stats.bot = bot;
    stats.roundKiller = -1;
    record = g_PlayerRecords.PushArray(stats, sizeof(stats));
    g_RecordIndex.SetValue(key, record);
  } else {
    MatchPlayerStats stats;
    g_PlayerRecords.GetArray(record, stats, sizeof(stats));
    if (!stats.bot) {
      strcopy(stats.name, sizeof(stats.name), name);
    }
    g_PlayerRecords.SetArray(record, stats, sizeof(stats));
  }

  for (int other = 1; other <= MaxClients; other++) {
    if (other != client && g_ClientRecord[other] == record) {
      g_ClientRecord[other] = -1;
      g_ClientSerial[other] = 0;
    }
  }
  g_ClientRecord[client] = record;
  g_ClientSerial[client] = serial;
  return record;
}

bool IsCurrentRecordClient(int client, int record) {
  if (!IsStatsClient(client) || record < 0 || record >= g_PlayerRecords.Length
      || g_ClientRecord[client] != record || g_ClientSerial[client] != GetClientSerial(client)) {
    return false;
  }
  MatchPlayerStats stats;
  g_PlayerRecords.GetArray(record, stats, sizeof(stats));
  if (stats.bot != IsFakeClient(client)) {
    return false;
  }
  if (!stats.bot || stats.steam64[0] != '\0') {
    char auth[COMPET_AUTH_SIZE];
    if (!GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), !stats.bot)
        || !StrEqual(auth, stats.steam64)) {
      return false;
    }
  }
  return true;
}

int RemainingPending(int pending, int previous, int current) {
  if (current < previous) {
    return 0;
  }
  int remaining = pending - (current - previous);
  return remaining > 0 ? remaining : 0;
}

bool RefreshNativeStats(int client, int record) {
  if (!ShouldRecordStats() || !IsCurrentRecordClient(client, record)) {
    return false;
  }
  int playerManager = FindEntityByClassname(-1, "cs_player_manager");
  if (playerManager == -1
      || !HasEntProp(playerManager, Prop_Send, "m_iKills")
      || !HasEntProp(playerManager, Prop_Send, "m_iDeaths")
      || !HasEntProp(playerManager, Prop_Send, "m_iAssists")
      || !HasEntProp(playerManager, Prop_Send, "m_iMatchStats_Damage_Total")
      || GetEntPropArraySize(playerManager, Prop_Send, "m_iKills") <= client
      || GetEntPropArraySize(playerManager, Prop_Send, "m_iDeaths") <= client
      || GetEntPropArraySize(playerManager, Prop_Send, "m_iAssists") <= client
      || GetEntPropArraySize(playerManager, Prop_Send, "m_iMatchStats_Damage_Total") <= client) {
    return false;
  }

  int kills = GetEntProp(playerManager, Prop_Send, "m_iKills", _, client);
  int deaths = GetEntProp(playerManager, Prop_Send, "m_iDeaths", _, client);
  int assists = GetEntProp(playerManager, Prop_Send, "m_iAssists", _, client);
  int damage = GetEntProp(playerManager, Prop_Send, "m_iMatchStats_Damage_Total", _, client);
  if (kills < 0 || deaths < 0 || assists < 0 || damage < 0) {
    return false;
  }

  MatchPlayerStats stats;
  g_PlayerRecords.GetArray(record, stats, sizeof(stats));
  int serial = g_ClientSerial[client];
  if (stats.lastNativeSerial != serial) {
    stats.pendingKills = 0;
    stats.pendingDeaths = 0;
    stats.pendingAssists = 0;
  } else {
    stats.pendingKills = RemainingPending(stats.pendingKills, stats.kills, kills);
    stats.pendingDeaths = RemainingPending(stats.pendingDeaths, stats.nativeDeaths, deaths);
    stats.pendingAssists = RemainingPending(stats.pendingAssists, stats.assists, assists);
  }
  stats.kills = kills;
  stats.nativeDeaths = deaths;
  stats.assists = assists;
  stats.damage = damage;
  stats.lastNativeSerial = serial;
  g_PlayerRecords.SetArray(record, stats, sizeof(stats));
  return true;
}

public void Frame_RefreshNativeStats(any serial) {
  int client = GetClientFromSerial(serial);
  if (client == 0) {
    return;
  }
  int record = g_ClientRecord[client];
  if (record != -1 && g_ClientSerial[client] == serial) {
    RefreshNativeStats(client, record);
  }
}

void RefreshAllNativeStats() {
  if (!ShouldRecordStats()) {
    return;
  }
  for (int client = 1; client <= MaxClients; client++) {
    if (!IsStatsClient(client)) {
      continue;
    }
    int record = EnsurePlayerRecord(client);
    if (record != -1) {
      RefreshNativeStats(client, record);
    }
  }
}

void RecordNativeStatEvent(int client, int record, int kind) {
  MatchPlayerStats before;
  g_PlayerRecords.GetArray(record, before, sizeof(before));
  int previous = kind == 0 ? before.kills : (kind == 1 ? before.nativeDeaths : before.assists);
  int pending = kind == 0 ? before.pendingKills : (kind == 1 ? before.pendingDeaths : before.pendingAssists);
  RefreshNativeStats(client, record);
  MatchPlayerStats stats;
  g_PlayerRecords.GetArray(record, stats, sizeof(stats));
  int current = kind == 0 ? stats.kills : (kind == 1 ? stats.nativeDeaths : stats.assists);
  if (current - previous <= pending) {
    if (kind == 0) {
      stats.pendingKills++;
    } else if (kind == 1) {
      stats.pendingDeaths++;
    } else {
      stats.pendingAssists++;
    }
    g_PlayerRecords.SetArray(record, stats, sizeof(stats));
  }
  RequestFrame(Frame_RefreshNativeStats, GetClientSerial(client));
}

void RecordDisconnect(int client) {
  if (client <= 0 || client > MaxClients) {
    return;
  }
  if (g_ClientRejected[client]) {
    g_ClientRecord[client] = -1;
    g_ClientSerial[client] = 0;
    g_ClientAdmitted[client] = false;
    return;
  }
  int record = g_ClientRecord[client];
  int serial = g_ClientSerial[client];
  bool admitted = g_ClientAdmitted[client];
  g_ClientAdmitted[client] = false;
  if (record == -1 || serial == 0) {
    return;
  }
  RefreshNativeStats(client, record);
  MatchPlayerStats stats;
  g_PlayerRecords.GetArray(record, stats, sizeof(stats));
  if (admitted && !stats.bot && !g_MatchFinalized) {
    stats.disconnects++;
  }
  if (ShouldRecordStats()) {
    bool alive = stats.roundAlive;
    if (IsStatsClient(client)) {
      alive = alive || IsPlayerAlive(client);
    }
    if (alive && !stats.roundDied) {
      stats.roundDied = true;
      stats.roundAlive = false;
      stats.pendingDeaths++;
    }
  }
  g_PlayerRecords.SetArray(record, stats, sizeof(stats));
  g_ClientRecord[client] = -1;
  g_ClientSerial[client] = 0;
  if (ShouldRecordStats()) {
    WriteMatchStats();
  }
}

bool IsStatsClient(int client) {
  return client > 0
    && client <= MaxClients
    && IsClientInGame(client)
    && !g_ClientRejected[client]
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
  if (g_MatchId[0] == '\0') {
    return;
  }
  if (!EnsureCompetMatchDataDir()) {
    LogError("[Compet] Could not create match stats directory for %s.", g_MatchId);
    return;
  }

  char path[PLATFORM_MAX_PATH];
  BuildMatchStatsPath(path, sizeof(path));
  File file = OpenFile(path, "w");
  if (file == null) {
    LogError("[Compet] Failed to open match stats file: %s", path);
    return;
  }

  char escapedMatchId[256];
  JsonEscape(g_MatchId, escapedMatchId, sizeof(escapedMatchId));
  bool written = true;
  written = WriteFileLine(file, "{") && written;
  written = WriteFileLine(file, "  \"matchId\": \"%s\",", escapedMatchId) && written;
  written = WriteFileLine(file, "  \"generatedAtUnix\": %d,", GetTime()) && written;
  written = WriteFileLine(file, "  \"firstHalfScore\":{\"t\":%d,\"ct\":%d},", g_FirstHalfScoreT, g_FirstHalfScoreCT) && written;
  written = WriteFileLine(file, "  \"secondHalfScore\":{\"t\":%d,\"ct\":%d},", g_SecondHalfScoreT, g_SecondHalfScoreCT) && written;
  written = WriteFileLine(file, "  \"players\": [") && written;

  for (int record = 0; record < g_PlayerRecords.Length; record++) {
    MatchPlayerStats stats;
    g_PlayerRecords.GetArray(record, stats, sizeof(stats));
    char escapedName[256];
    char escapedSteam64[64];
    JsonEscape(stats.name, escapedName, sizeof(escapedName));
    JsonEscape(stats.steam64, escapedSteam64, sizeof(escapedSteam64));
    written = WriteFileLine(
      file,
      "    %s{\"name\":\"%s\",\"steam64\":\"%s\",\"kills\":%d,\"deaths\":%d,\"assists\":%d,\"damage\":%d,\"headshots\":%d,\"kastRounds\":%d,\"roundsPlayed\":%d}",
      record == 0 ? "" : ",",
      escapedName,
      escapedSteam64,
      stats.kills + stats.pendingKills,
      stats.nativeDeaths + stats.pendingDeaths,
      stats.assists + stats.pendingAssists,
      stats.damage,
      stats.headshots,
      stats.kastRounds,
      stats.roundsPlayed
    ) && written;
  }

  written = WriteFileLine(file, "  ]") && written;
  written = WriteFileLine(file, "}") && written;
  written = FlushFile(file) && written;
  delete file;
  if (!written) {
    LogError("[Compet] Failed to write complete match stats file: %s", path);
  }
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
  if (!g_MatchFinalized) {
    RefreshAllNativeStats();
    WriteMatchStats();
    g_MatchFinalized = true;
    g_StatsActive = false;
  }
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
