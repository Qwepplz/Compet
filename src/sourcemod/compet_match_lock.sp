#include <sourcemod>
#include <cstrike>
#include <sdktools_gamerules>

#pragma semicolon 1
#pragma newdecls required

static const int DEFAULT_WARMUP_TIMEOUT_SECONDS = 600;
static const int MIN_WARMUP_TIMEOUT_SECONDS = 5;
static const int DEFAULT_DISCONNECT_GRACE_SECONDS = 60;
static const int GET5_STATE_KNIFE_ROUND = 4;
static const int GET5_STATE_POSTGAME = 9;

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
bool g_WarmupWasActive = false;
char g_MatchId[128] = "";
ConVar g_WarmupTimeoutSecondsCvar = null;
ConVar g_DisconnectGraceSecondsCvar = null;
Handle g_EnforceTimer = null;
Handle g_WarmupTimeoutTimer = null;
Handle g_DisconnectShutdownTimer = null;
float g_WarmupDeadline = 0.0;
int g_LastWarmupNoticeSeconds = -1;

public void OnPluginStart() {
  g_PlayerTeams = new StringMap();
  g_WarmupTimeoutSecondsCvar = CreateConVar("compet_warmup_timeout_seconds", "600", "Compet warmup shutdown timeout in seconds.", 0, true, float(MIN_WARMUP_TIMEOUT_SECONDS));
  g_DisconnectGraceSecondsCvar = CreateConVar("compet_disconnect_grace_seconds", "60", "Seconds to wait before shutting down after all assigned players disconnect before get5 starts.", 0, true, 0.0);
  RegServerCmd("compet_lock_reset", Command_ResetLock);
  RegServerCmd("compet_lock_add", Command_AddPlayer);
  RegServerCmd("compet_lock_enable", Command_EnableLock);
  RegServerCmd("compet_lock_test_get5_started", Command_TestGet5Started);
  RegServerCmd("compet_lock_test_warmup_end", Command_TestWarmupEnd);
  RegServerCmd("compet_lock_test_empty_server", Command_TestEmptyServer);
  AddCommandListener(Command_JoinTeam, "jointeam");
  AddCommandListener(Command_JoinTeam, "joingame");
  PrintToServer("[Compet] Match lock plugin loaded; waiting for compet_lock_reset.");
}

public void OnPluginEnd() {
  StopWarmupTimeout();
  StopDisconnectShutdownTimer();
}

public void OnClientPostAdminCheck(int client) {
  if (!g_LockEnabled || IsFakeClient(client)) {
    return;
  }

  if (IsAssignedClient(client)) {
    StopDisconnectShutdownTimer();
  }
  PrintWarmupStatusToClient(client);
  CreateTimer(0.2, Timer_ApplyClientLock, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
}

public void OnClientDisconnect(int client) {
  if (!g_LockEnabled || g_Get5Started || IsFakeClient(client)) {
    return;
  }
  CreateTimer(0.2, Timer_CheckEmptyServerAfterDisconnect, 0, TIMER_FLAG_NO_MAPCHANGE);
}

public Action Command_ResetLock(int args) {
  g_PlayerTeams.Clear();
  g_LockEnabled = false;
  g_Get5Started = false;
  g_WarmupWasActive = false;
  StopEnforceTimer();
  StopDisconnectShutdownTimer();
  g_MatchId[0] = '\0';
  if (args >= 1) {
    GetCmdArg(1, g_MatchId, sizeof(g_MatchId));
  }
  RestartWarmupTimeout();
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

public void Get5_OnGameStateChanged(Handle event) {
  MaybeMarkGet5StartedFromState("get5 game state changed");
}

public void Get5_OnKnifeRoundStarted(Handle event) {
  MarkGet5Started("get5 knife round started");
}

public void Get5_OnGoingLive(Handle event) {
  MarkGet5Started("get5 going live");
}

public Action Command_TestGet5Started(int args) {
  MarkGet5Started("manual test command");
  return Plugin_Handled;
}

public Action Command_TestWarmupEnd(int args) {
  g_WarmupWasActive = true;
  MaybeShutdownForWarmupEnd();
  return Plugin_Handled;
}

public Action Command_TestEmptyServer(int args) {
  MaybeShutdownForEmptyServer();
  return Plugin_Handled;
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

public Action Timer_ApplyClientLock(Handle timer, int userId) {
  int client = GetClientOfUserId(userId);
  if (client > 0 && IsClientInGame(client) && !IsFakeClient(client)) {
    ApplyClientLock(client, false, CS_TEAM_NONE);
  }
  return Plugin_Stop;
}

public Action Timer_CheckEmptyServerAfterDisconnect(Handle timer, any data) {
  ScheduleDisconnectShutdownIfEmpty();
  return Plugin_Stop;
}

public Action Timer_DisconnectShutdown(Handle timer, any data) {
  g_DisconnectShutdownTimer = null;
  MaybeShutdownForEmptyServer();
  return Plugin_Stop;
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
    if (fromCommand) {
      PrintToChat(client, "[Compet] You have been assigned to your match team.");
    }
    return false;
  }

  int currentTeam = GetClientTeam(client);
  if (currentTeam != lockedTeam) {
    ChangeClientTeam(client, lockedTeam);
    if (fromCommand) {
      PrintToChat(client, "[Compet] You have been assigned to your match team.");
    }
    return false;
  }

  return !fromCommand;
}

void StartEnforceTimer() {
  if (g_EnforceTimer != null) {
    return;
  }
  g_EnforceTimer = CreateTimer(1.0, Timer_EnforceLocks, 0, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
}

void StopEnforceTimer() {
  if (g_EnforceTimer == null) {
    return;
  }
  delete g_EnforceTimer;
  g_EnforceTimer = null;
}

void RestartWarmupTimeout() {
  if (g_Get5Started) {
    return;
  }
  int warmupSeconds = GetWarmupTimeoutSeconds();
  StopWarmupTimeout();
  g_WarmupDeadline = GetEngineTime() + float(warmupSeconds);
  g_WarmupWasActive = true;
  g_LastWarmupNoticeSeconds = -1;
  StartWarmupCountdown(warmupSeconds);
  PrintToServer("[Compet] Warmup shutdown guard started for match %s: %d seconds.", g_MatchId, warmupSeconds);
  PrintWarmupNoticeToAll(warmupSeconds);
  g_WarmupTimeoutTimer = CreateTimer(1.0, Timer_WarmupTick, 0, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
}

void StartWarmupCountdown(int warmupSeconds) {
  SetConVarIntIfExists("mp_do_warmup_period", 1);
  SetConVarIntIfExists("mp_warmuptime", warmupSeconds);
  SetConVarIntIfExists("mp_warmuptime_all_players_connected", 0);
  SetConVarIntIfExists("mp_warmup_pausetimer", 0);
  ServerCommand("mp_warmup_start");
  ServerExecute();
}

void StopWarmupTimeout() {
  if (g_WarmupTimeoutTimer != null) {
    delete g_WarmupTimeoutTimer;
    g_WarmupTimeoutTimer = null;
  }
  g_WarmupDeadline = 0.0;
  g_WarmupWasActive = false;
  g_LastWarmupNoticeSeconds = -1;
}

void MarkGet5Started(const char[] reason) {
  if (g_Get5Started || !g_LockEnabled || g_MatchId[0] == '\0') {
    return;
  }
  g_Get5Started = true;
  PrintToServer("[Compet] %s; automatic shutdown cancelled for match %s.", reason, g_MatchId);
  PrintToChatAll("[Compet] get5 has started; automatic warmup shutdown cancelled.");
  StopWarmupTimeout();
  StopDisconnectShutdownTimer();
}

public Action Timer_WarmupTick(Handle timer, any data) {
  MaybeMarkGet5StartedFromState("get5 active state detected");
  if (g_Get5Started) {
    g_WarmupTimeoutTimer = null;
    return Plugin_Stop;
  }

  bool warmupActive = IsGameWarmupActive();
  if (g_WarmupWasActive && !warmupActive) {
    g_WarmupTimeoutTimer = null;
    MaybeShutdownForWarmupEnd();
    return Plugin_Stop;
  }
  g_WarmupWasActive = warmupActive;

  int secondsRemaining = SecondsUntilWarmupShutdown();
  if (secondsRemaining <= 0) {
    g_WarmupTimeoutTimer = null;
    MaybeShutdownForWarmupEnd();
    return Plugin_Stop;
  }

  if (ShouldPrintWarmupNotice(secondsRemaining)) {
    PrintWarmupNoticeToAll(secondsRemaining);
  }
  return Plugin_Continue;
}

void PrintWarmupNoticeToAll(int secondsRemaining) {
  int minutes = secondsRemaining / 60;
  int seconds = secondsRemaining % 60;
  PrintToChatAll("[Compet] Warmup ends in %d:%02d. Use !get5 before the server closes.", minutes, seconds);
}

void PrintWarmupStatusToClient(int client) {
  int secondsRemaining = SecondsUntilWarmupShutdown();
  if (secondsRemaining <= 0) {
    return;
  }
  int minutes = secondsRemaining / 60;
  int seconds = secondsRemaining % 60;
  PrintToChat(client, "[Compet] Warmup ends in %d:%02d. Use !get5 before the server closes.", minutes, seconds);
}

bool ShouldPrintWarmupNotice(int secondsRemaining) {
  if (secondsRemaining == g_LastWarmupNoticeSeconds) {
    return false;
  }
  if (secondsRemaining == 300 || secondsRemaining == 120 || secondsRemaining == 60 || secondsRemaining == 30 || secondsRemaining <= 10) {
    g_LastWarmupNoticeSeconds = secondsRemaining;
    return true;
  }
  return false;
}

int SecondsUntilWarmupShutdown() {
  if (g_WarmupDeadline <= 0.0) {
    return 0;
  }
  return RoundToCeil(g_WarmupDeadline - GetEngineTime());
}

int GetWarmupTimeoutSeconds() {
  int seconds = DEFAULT_WARMUP_TIMEOUT_SECONDS;
  if (g_WarmupTimeoutSecondsCvar != null) {
    seconds = g_WarmupTimeoutSecondsCvar.IntValue;
  }
  return seconds < MIN_WARMUP_TIMEOUT_SECONDS ? MIN_WARMUP_TIMEOUT_SECONDS : seconds;
}

int GetDisconnectGraceSeconds() {
  if (g_DisconnectGraceSecondsCvar == null) {
    return DEFAULT_DISCONNECT_GRACE_SECONDS;
  }
  int seconds = g_DisconnectGraceSecondsCvar.IntValue;
  return seconds < 0 ? 0 : seconds;
}

bool IsGameWarmupActive() {
  return GameRules_GetProp("m_bWarmupPeriod") != 0;
}

void MaybeMarkGet5StartedFromState(const char[] reason) {
  if (g_Get5Started || !g_LockEnabled || g_MatchId[0] == '\0') {
    return;
  }
  ConVar stateCvar = FindConVar("get5_game_state");
  if (stateCvar == null) {
    return;
  }
  if (IsGet5StartedState(stateCvar.IntValue)) {
    MarkGet5Started(reason);
  }
}

bool IsGet5StartedState(int state) {
  return state >= GET5_STATE_KNIFE_ROUND && state <= GET5_STATE_POSTGAME;
}

void MaybeShutdownForWarmupEnd() {
  if (!g_LockEnabled || g_MatchId[0] == '\0') {
    return;
  }
  MaybeMarkGet5StartedFromState("get5 active state detected at warmup end");
  if (g_Get5Started) {
    return;
  }
  ShutdownServer("Game warmup ended before get5 started; shutting down server.", "[Compet] Warmup ended before get5 started; shutting down server.");
}

void ScheduleDisconnectShutdownIfEmpty() {
  if (!g_LockEnabled || g_Get5Started || g_MatchId[0] == '\0') {
    return;
  }
  if (CountConnectedAssignedPlayers() > 0) {
    StopDisconnectShutdownTimer();
    return;
  }
  if (g_DisconnectShutdownTimer != null) {
    return;
  }
  int graceSeconds = GetDisconnectGraceSeconds();
  if (graceSeconds <= 0) {
    MaybeShutdownForEmptyServer();
    return;
  }
  PrintToServer("[Compet] No assigned players remain before get5 started; shutting down in %d seconds unless someone reconnects.", graceSeconds);
  g_DisconnectShutdownTimer = CreateTimer(float(graceSeconds), Timer_DisconnectShutdown, 0, TIMER_FLAG_NO_MAPCHANGE);
}

void MaybeShutdownForEmptyServer() {
  if (!g_LockEnabled || g_MatchId[0] == '\0') {
    return;
  }
  MaybeMarkGet5StartedFromState("get5 active state detected before empty-server shutdown");
  if (g_Get5Started || CountConnectedAssignedPlayers() > 0) {
    return;
  }
  ShutdownServer("All assigned players disconnected before get5 started; shutting down server.", "[Compet] All assigned players disconnected before get5 started; shutting down server.");
}

void StopDisconnectShutdownTimer() {
  if (g_DisconnectShutdownTimer != null) {
    delete g_DisconnectShutdownTimer;
    g_DisconnectShutdownTimer = null;
  }
}

void ShutdownServer(const char[] serverMessage, const char[] chatMessage) {
  PrintToChatAll("%s", chatMessage);
  PrintToServer("[Compet] %s", serverMessage);
  ServerCommand("quit");
  ServerExecute();
}

void SetConVarIntIfExists(const char[] name, int value) {
  ConVar cvar = FindConVar(name);
  if (cvar == null) {
    PrintToServer("[Compet] Missing warmup cvar: %s", name);
    return;
  }
  cvar.IntValue = value;
}

bool IsAssignedClient(int client) {
  if (client <= 0 || !IsClientInGame(client) || IsFakeClient(client)) {
    return false;
  }
  char auth[32];
  if (!GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), true)) {
    return false;
  }
  int lockedTeam = CS_TEAM_NONE;
  return g_PlayerTeams.GetValue(auth, lockedTeam);
}

int CountConnectedAssignedPlayers() {
  int count = 0;
  for (int client = 1; client <= MaxClients; client++) {
    if (IsAssignedClient(client)) {
      count++;
    }
  }
  return count;
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
