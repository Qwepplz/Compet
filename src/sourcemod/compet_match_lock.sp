#include <sourcemod>
#include <cstrike>
#include <sdktools_gamerules>

#pragma semicolon 1
#pragma newdecls required

static const int DEFAULT_WARMUP_TIMEOUT_SECONDS = 600;
static const int MIN_WARMUP_TIMEOUT_SECONDS = 5;
static const int DEFAULT_DISCONNECT_GRACE_SECONDS = 60;
static const int DEFAULT_NO_HUMAN_SHUTDOWN_SECONDS = 600;
static const int MIN_NO_HUMAN_SHUTDOWN_SECONDS = 5;
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
ConVar g_NoHumanShutdownSecondsCvar = null;
Handle g_EnforceTimer = null;
Handle g_WarmupTimeoutTimer = null;
Handle g_DisconnectShutdownTimer = null;
Handle g_NoHumanShutdownTimer = null;
float g_WarmupDeadline = 0.0;
float g_NoHumanShutdownDeadline = 0.0;
int g_LastWarmupNoticeSeconds = -1;

public void OnPluginStart() {
  g_PlayerTeams = new StringMap();
  g_WarmupTimeoutSecondsCvar = CreateConVar("compet_warmup_timeout_seconds", "600", "Compet warmup shutdown timeout in seconds.", 0, true, float(MIN_WARMUP_TIMEOUT_SECONDS));
  g_DisconnectGraceSecondsCvar = CreateConVar("compet_disconnect_grace_seconds", "60", "Seconds to wait before shutting down after all assigned players disconnect before get5 starts.", 0, true, 0.0);
  g_NoHumanShutdownSecondsCvar = CreateConVar("compet_no_human_shutdown_seconds", "600", "Seconds to wait before shutting down when no human players remain, regardless of match state.", 0, true, float(MIN_NO_HUMAN_SHUTDOWN_SECONDS));
  RegServerCmd("compet_lock_reset", Command_ResetLock);
  RegServerCmd("compet_lock_add", Command_AddPlayer);
  RegServerCmd("compet_lock_enable", Command_EnableLock);
  RegServerCmd("compet_lock_test_get5_started", Command_TestGet5Started);
  RegServerCmd("compet_lock_test_warmup_end", Command_TestWarmupEnd);
  RegServerCmd("compet_lock_test_empty_server", Command_TestEmptyServer);
  RegServerCmd("compet_lock_test_no_humans", Command_TestNoHumans);
  AddCommandListener(Command_JoinTeam, "jointeam");
  AddCommandListener(Command_JoinTeam, "joingame");
  PrintToServer("[Compet] Match lock plugin loaded; waiting for compet_lock_reset.");
}

public void OnConfigsExecuted() {
  ScheduleNoHumanShutdownIfEmpty();
}

public void OnPluginEnd() {
  StopEnforceTimer();
  StopWarmupTimeout();
  StopDisconnectShutdownTimer();
  StopNoHumanShutdownTimer();
}

public void OnMapEnd() {
  g_EnforceTimer = null;
  g_WarmupTimeoutTimer = null;
  g_DisconnectShutdownTimer = null;
  g_NoHumanShutdownTimer = null;
}

public void OnMapStart() {
  if (g_NoHumanShutdownDeadline > 0.0) {
    ScheduleNoHumanShutdownIfEmpty();
  }
}

public void OnClientPostAdminCheck(int client) {
  if (!IsFakeClient(client)) {
    StopNoHumanShutdownTimer();
  }

  if (!g_LockEnabled || IsFakeClient(client)) {
    return;
  }

  if (!EnsureWarmupShutdownGuard()) {
    return;
  }
  if (IsAssignedClient(client)) {
    StopDisconnectShutdownTimer();
  }
  PrintWarmupStatusToClient(client);
  CreateTimer(0.2, Timer_ApplyClientLock, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
}

public void OnClientDisconnect(int client) {
  if (!IsFakeClient(client)) {
    CreateTimer(0.2, Timer_CheckNoHumansAfterDisconnect, 0, TIMER_FLAG_NO_MAPCHANGE);
  }

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

public Action Command_TestNoHumans(int args) {
  MaybeShutdownForNoHumans();
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

public Action Timer_CheckNoHumansAfterDisconnect(Handle timer, any data) {
  ScheduleNoHumanShutdownIfEmpty();
  return Plugin_Stop;
}

public Action Timer_DisconnectShutdown(Handle timer, any data) {
  g_DisconnectShutdownTimer = null;
  MaybeShutdownForEmptyServer();
  return Plugin_Stop;
}

public Action Timer_NoHumanShutdown(Handle timer, any data) {
  g_NoHumanShutdownTimer = null;
  MaybeShutdownForNoHumans();
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
  g_LockEnabled = false;
  StopEnforceTimer();
  PrintToServer("[Compet] %s; pre-get5 team lock disabled for match %s.", reason, g_MatchId);
  PrintToChatAll("[Compet] get5 has started; pre-match team lock disabled.");
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

int GetNoHumanShutdownSeconds() {
  int seconds = DEFAULT_NO_HUMAN_SHUTDOWN_SECONDS;
  if (g_NoHumanShutdownSecondsCvar != null) {
    seconds = g_NoHumanShutdownSecondsCvar.IntValue;
  }
  return seconds < MIN_NO_HUMAN_SHUTDOWN_SECONDS ? MIN_NO_HUMAN_SHUTDOWN_SECONDS : seconds;
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

bool EnsureWarmupShutdownGuard() {
  if (!g_LockEnabled || g_Get5Started || g_MatchId[0] == '\0') {
    return true;
  }
  MaybeMarkGet5StartedFromState("get5 active state detected while restoring warmup guard");
  if (g_Get5Started) {
    return true;
  }
  if (g_WarmupWasActive && !IsGameWarmupActive()) {
    MaybeShutdownForWarmupEnd();
    return false;
  }
  if (g_WarmupDeadline > 0.0) {
    if (SecondsUntilWarmupShutdown() <= 0) {
      MaybeShutdownForWarmupEnd();
      return false;
    }
    if (g_WarmupTimeoutTimer == null) {
      g_WarmupTimeoutTimer = CreateTimer(1.0, Timer_WarmupTick, 0, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
      PrintToServer("[Compet] Warmup shutdown guard restored for match %s after server wake/map reload.", g_MatchId);
    }
    return true;
  }
  RestartWarmupTimeout();
  return true;
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

void ScheduleNoHumanShutdownIfEmpty() {
  if (CountConnectedHumanPlayers() > 0) {
    StopNoHumanShutdownTimer();
    return;
  }
  if (g_NoHumanShutdownTimer != null) {
    return;
  }
  if (g_NoHumanShutdownDeadline <= 0.0) {
    int timeoutSeconds = GetNoHumanShutdownSeconds();
    g_NoHumanShutdownDeadline = GetEngineTime() + float(timeoutSeconds);
    PrintToServer("[Compet] No human players connected; shutting down in %d seconds unless someone joins.", timeoutSeconds);
  }

  int secondsRemaining = SecondsUntilNoHumanShutdown();
  if (secondsRemaining <= 0) {
    MaybeShutdownForNoHumans();
    return;
  }
  g_NoHumanShutdownTimer = CreateTimer(float(secondsRemaining), Timer_NoHumanShutdown, 0, TIMER_FLAG_NO_MAPCHANGE);
}

void MaybeShutdownForNoHumans() {
  if (CountConnectedHumanPlayers() > 0) {
    StopNoHumanShutdownTimer();
    return;
  }
  ShutdownServer("No human players connected for the configured timeout; shutting down server.", "[Compet] No human players connected for too long; shutting down server.");
}

void StopDisconnectShutdownTimer() {
  if (g_DisconnectShutdownTimer != null) {
    delete g_DisconnectShutdownTimer;
    g_DisconnectShutdownTimer = null;
  }
}

void StopNoHumanShutdownTimer() {
  if (g_NoHumanShutdownTimer != null) {
    delete g_NoHumanShutdownTimer;
    g_NoHumanShutdownTimer = null;
  }
  g_NoHumanShutdownDeadline = 0.0;
}

int SecondsUntilNoHumanShutdown() {
  if (g_NoHumanShutdownDeadline <= 0.0) {
    return 0;
  }
  return RoundToCeil(g_NoHumanShutdownDeadline - GetEngineTime());
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

int CountConnectedHumanPlayers() {
  int count = 0;
  for (int client = 1; client <= MaxClients; client++) {
    if (IsClientConnected(client) && !IsFakeClient(client)) {
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
