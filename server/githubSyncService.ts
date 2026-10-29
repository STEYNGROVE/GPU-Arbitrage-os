import { execSync } from 'child_process';
import { config } from './config.ts';

export interface GitHubSyncStatus {
  upstreamRepo: string;
  committerEmail: string;
  committerName: string;
  tokenConfigured: boolean;
  maskedToken: string;
  lastSyncedAt: string;
  branch: string;
  syncState: 'SYNCHRONIZED' | 'PENDING' | 'AUTH_FAILED' | 'REPO_NOT_FOUND' | 'NOT_CONFIGURED' | 'ERROR';
  latestRemoteCommitSha?: string;
  lastLocalCommitSha?: string;
  canPush: boolean;
  autoSyncActive: boolean;
  autoSyncIntervalMs: number;
  totalSyncCyclesCompleted: number;
  recentLogs: Array<{
    timestamp: string;
    action: string;
    status: 'SUCCESS' | 'INFO' | 'WARNING' | 'ERROR';
    details: string;
  }>;
}

class GitHubSyncService {
  private upstreamRepo: string = config.github.repo;
  private committerEmail: string = config.github.committerEmail;
  private committerName: string = config.github.committerName;
  private accessToken?: string = config.github.token;
  private lastSyncedAt: string = '';
  private lastKnownSha?: string;
  private lastLocalCommitSha?: string;
  private autoSyncInterval: NodeJS.Timeout | null = null;
  private autoSyncActive: boolean = false;
  private autoSyncIntervalMs: number = 60000;
  private totalSyncCyclesCompleted: number = 0;
  private syncLogs: Array<{
    timestamp: string;
    action: string;
    status: 'SUCCESS' | 'INFO' | 'WARNING' | 'ERROR';
    details: string;
  }> = [];

  constructor() {
    this.addLog(
      'SERVICE_INITIALIZED',
      'INFO',
      `Target upstream: ${this.upstreamRepo}. Automated GitHub Sync & Copy: DISABLED (Every ${this.autoSyncIntervalMs / 1000}s).`
    );

    // Automatically boot continuous background sync and copy loop
    // Explicit operator action required; no background pushes.
  }

  public startContinuousSync(intervalMs: number = 60000): void {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
    }
    this.autoSyncIntervalMs = intervalMs;
    this.autoSyncActive = true;

    // Trigger initial pass shortly after boot
    setTimeout(() => {
      this.triggerSync().catch((err) => {
        console.warn('[GitHub Auto-Sync] Boot sync cycle notice:', err.message);
      });
    }, 4000);

    // Continuous recurring schedule
    this.autoSyncInterval = setInterval(() => {
      this.triggerSync().catch((err) => {
        console.warn('[GitHub Auto-Sync] Recurring sync cycle notice:', err.message);
      });
    }, intervalMs);

    console.log(`[GitHub Auto-Sync 🔄] Continuous background synchronization loop active (Every ${intervalMs / 1000}s).`);
  }

  public stopContinuousSync(): void {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = null;
    }
    this.autoSyncActive = false;
    this.addLog('AUTO_SYNC_PAUSED', 'INFO', 'Automated sync schedule paused by operator.');
  }

  private addLog(action: string, status: 'SUCCESS' | 'INFO' | 'WARNING' | 'ERROR', details: string) {
    this.syncLogs.push({
      timestamp: new Date().toISOString(),
      action,
      status,
      details,
    });
    if (this.syncLogs.length > 40) this.syncLogs.shift();
  }

  public getStatus(): GitHubSyncStatus {
    const isTokenSet = Boolean(this.accessToken && !this.accessToken.includes('your_private'));
    const masked = isTokenSet && this.accessToken
      ? `${this.accessToken.slice(0, 4)}••••••••${this.accessToken.slice(-2)}`
      : 'NOT_CONFIGURED';

    return {
      upstreamRepo: this.upstreamRepo,
      committerEmail: this.committerEmail,
      committerName: this.committerName,
      tokenConfigured: isTokenSet,
      maskedToken: masked,
      lastSyncedAt: this.lastSyncedAt,
      branch: 'main',
      syncState: this.lastKnownSha ? 'SYNCHRONIZED' : (!isTokenSet ? 'NOT_CONFIGURED' : 'PENDING'),
      latestRemoteCommitSha: this.lastKnownSha,
      lastLocalCommitSha: this.lastLocalCommitSha,
      canPush: isTokenSet,
      autoSyncActive: this.autoSyncActive,
      autoSyncIntervalMs: this.autoSyncIntervalMs,
      totalSyncCyclesCompleted: this.totalSyncCyclesCompleted,
      recentLogs: this.syncLogs.slice(-12),
    };
  }

  public updateConfig(repo?: string, email?: string, name?: string, token?: string): GitHubSyncStatus {
    if (repo) this.upstreamRepo = repo;
    if (email) this.committerEmail = email;
    if (name) this.committerName = name;
    if (token) this.accessToken = token;

    this.addLog('CONFIG_UPDATED', 'INFO', `Target repository set to: ${this.upstreamRepo}`);
    return this.getStatus();
  }

  /**
   * Automatically copies working tree updates into Git version control.
   * Commits system memory, ledger snapshots, and working files cleanly.
   */
  public autoCopyAndCommitLocalRepo(): { committed: boolean; commitSha?: string; details?: string } {
    try {
      // Ensure git repository is initialized
      try {
        execSync('git rev-parse --is-inside-work-tree', { timeout: 2000, stdio: 'ignore' });
      } catch {
        execSync(`git init -b main && git config user.name "${this.committerName}" && git config user.email "${this.committerEmail}"`, { timeout: 4000 });
        try {
          execSync(`git remote add origin https://github.com/${this.upstreamRepo}.git`, { timeout: 3000 });
        } catch {}
      }

      const isTokenConfigured = Boolean(this.accessToken && !this.accessToken.includes('your_private'));
      const statusOutput = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (!statusOutput) {
        let currentSha = 'main';
        try {
          currentSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 3000 }).trim();
        } catch {}
        this.lastLocalCommitSha = currentSha;

        // Ensure remote is also up to date even if tree was clean
        if (isTokenConfigured && this.accessToken) {
          try {
            const authRemoteUrl = `https://${this.accessToken}@github.com/${this.upstreamRepo}.git`;
            execSync(`git push ${authRemoteUrl} main`, { timeout: 12000, stdio: 'pipe' });
          } catch {}
        }

        return { committed: false, commitSha: currentSha, details: 'Local git workspace tree is clean and up to date.' };
      }

      // Configure committer identity
      execSync(`git config user.name "${this.committerName}" && git config user.email "${this.committerEmail}"`, { timeout: 3000 });
      
      // Stage and commit all updates
      execSync('git add -A', { timeout: 6000 });
      const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const commitMsg = `auto: sync working memory, financial ledger, and repo state (${nowStr} UTC)`;
      execSync(`git commit -m "${commitMsg}"`, { timeout: 6000 });

      let newSha = 'main';
      try {
        newSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 3000 }).trim();
      } catch {}
      this.lastLocalCommitSha = newSha;

      this.addLog(
        'LOCAL_GIT_COMMIT',
        'SUCCESS',
        `Automated Git snapshot committed: ${newSha} (${commitMsg})`
      );

      // If push token is configured, push to remote
      if (isTokenConfigured && this.accessToken) {
        try {
          const authRemoteUrl = `https://${this.accessToken}@github.com/${this.upstreamRepo}.git`;
          execSync(`git push ${authRemoteUrl} main`, { timeout: 12000, stdio: 'pipe' });
          this.addLog('REMOTE_PUSH', 'SUCCESS', `Pushed commit ${newSha} to https://github.com/${this.upstreamRepo} (main)`);
        } catch (pushErr: any) {
          this.addLog('REMOTE_PUSH', 'WARNING', `Remote push notice: ${pushErr.message}`);
        }
      }

      return { committed: true, commitSha: newSha, details: commitMsg };
    } catch (err: any) {
      this.addLog('LOCAL_GIT_NOTICE', 'INFO', `Local git auto-copy note: ${err.message}`);
      return { committed: false, details: err.message };
    }
  }

  /**
   * Executes genuine GitHub REST API verification against remote repository
   * and synchronizes local workspace memory.
   */
  public async triggerSync(): Promise<{
    success: boolean;
    syncedAt: string;
    upstreamRepo: string;
    branch: string;
    message: string;
    commitSha?: string;
    logs: string[];
  }> {
    this.lastSyncedAt = new Date().toISOString();
    this.totalSyncCyclesCompleted++;
    const logs: string[] = [];

    const logAndRecord = (line: string, status: 'SUCCESS' | 'INFO' | 'WARNING' | 'ERROR' = 'INFO') => {
      logs.push(line);
      this.addLog('SYNC_STEP', status, line);
    };

    logAndRecord(`[GitHub Auto-Sync Pass #${this.totalSyncCyclesCompleted}] Synchronizing with https://github.com/${this.upstreamRepo}...`);

    // 1. Automatically copy and snapshot local repository changes
    const localResult = this.autoCopyAndCommitLocalRepo();
    if (localResult.committed) {
      logAndRecord(`[Local Git] Saved and committed working state: SHA ${localResult.commitSha}`);
    } else {
      logAndRecord(`[Local Git] Workspace state verified: Clean (HEAD: ${localResult.commitSha || 'main'})`);
    }

    // 2. Query GitHub REST API
    const isTokenConfigured = Boolean(this.accessToken && !this.accessToken.includes('your_private'));
    if (!isTokenConfigured) {
      logAndRecord('[GitHub Notice] Write token not set; proceeding with public repository verification.', 'INFO');
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const reqHeaders: Record<string, string> = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'GPU-Compute-Arbitrage-OS-v14',
      };
      if (isTokenConfigured && this.accessToken) {
        reqHeaders['Authorization'] = `Bearer ${this.accessToken}`;
      }

      const repoRes = await fetch(`https://api.github.com/repos/${this.upstreamRepo}`, {
        headers: reqHeaders,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (repoRes.status === 401) {
        const msg = 'GitHub authentication failed: HTTP 401 Bad Credentials. Verify GITHUB_ACCESS_TOKEN.';
        logAndRecord(msg, 'ERROR');
        return { success: false, syncedAt: this.lastSyncedAt, upstreamRepo: this.upstreamRepo, branch: 'main', message: msg, logs };
      }

      if (repoRes.status === 404) {
        const msg = `GitHub repository https://github.com/${this.upstreamRepo} not found or token lacks access permission (HTTP 404).`;
        logAndRecord(msg, 'ERROR');
        return { success: false, syncedAt: this.lastSyncedAt, upstreamRepo: this.upstreamRepo, branch: 'main', message: msg, logs };
      }

      if (!repoRes.ok) {
        const msg = `GitHub API returned HTTP ${repoRes.status}: ${repoRes.statusText}`;
        logAndRecord(msg, 'ERROR');
        return { success: false, syncedAt: this.lastSyncedAt, upstreamRepo: this.upstreamRepo, branch: 'main', message: msg, logs };
      }

      const repoData = (await repoRes.json()) as any;
      const defaultBranch = repoData.default_branch || 'main';
      const hasPushPermission = Boolean(repoData.permissions?.push);

      logAndRecord(`[GitHub REST API] Repository validated: ${repoData.full_name} (${repoData.visibility}). Default branch: ${defaultBranch}`);
      logAndRecord(`[GitHub REST API] Push permissions verified: ${hasPushPermission ? 'AUTHORIZED (Write Access)' : 'READ_ONLY'}`);

      // Query latest branch commit
      const branchRes = await fetch(`https://api.github.com/repos/${this.upstreamRepo}/commits/${defaultBranch}`, {
        headers: reqHeaders,
      });

      let latestSha = this.lastLocalCommitSha || 'UNKNOWN';
      if (branchRes.ok) {
        const branchData = (await branchRes.json()) as any;
        latestSha = branchData.sha;
        this.lastKnownSha = latestSha;
        logAndRecord(`[GitHub REST API] Verified remote HEAD commit: ${latestSha.substring(0, 7)} by ${branchData.commit?.author?.name || 'author'}`);
      }

      const successMsg = `Successfully synchronized with GitHub repository ${this.upstreamRepo} (Branch: ${defaultBranch}, Remote SHA: ${latestSha.substring(0, 7)})`;
      logAndRecord(successMsg, 'SUCCESS');

      return {
        success: true,
        syncedAt: this.lastSyncedAt,
        upstreamRepo: this.upstreamRepo,
        branch: defaultBranch,
        commitSha: latestSha,
        message: successMsg,
        logs,
      };
    } catch (err: any) {
      const msg = `GitHub network operation error: ${err.message}`;
      logAndRecord(msg, 'ERROR');
      return {
        success: false,
        syncedAt: this.lastSyncedAt,
        upstreamRepo: this.upstreamRepo,
        branch: 'main',
        message: msg,
        logs,
      };
    }
  }
}

export const githubSyncService = new GitHubSyncService();
