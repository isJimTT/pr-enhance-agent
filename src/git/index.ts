import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { simpleGit, SimpleGit } from "simple-git";

export interface GitContext {
  owner: string;
  repo: string;
  workspaceDir: string;
  token: string;
  provider: "gitee" | "github";
  host?: string; // e.g. e.gitee.com for enterprise Gitee
}

export class GitEngine {
  private git: SimpleGit | null = null;
  private ctx: GitContext;

  constructor(ctx: GitContext) {
    this.ctx = ctx;
  }

  get workspaceDir(): string {
    return this.ctx.workspaceDir;
  }

  private remoteUrl(): string {
    // Allow overriding the full clone URL via env var
    const cloneUrl = process.env.GIT_CLONE_URL;
    if (cloneUrl) {
      return cloneUrl.replace("https://", `https://oauth2:${this.ctx.token}@`);
    }

    let host = this.ctx.host ?? (this.ctx.provider === "gitee" ? "gitee.com" : "github.com");
    host = host.replace(/^https?:\/\//, "");
    return `https://oauth2:${this.ctx.token}@${host}/${this.ctx.owner}/${this.ctx.repo}.git`;
  }

  async ensureRepo(sourceRef?: string, targetRef?: string): Promise<void> {
    const dir = this.ctx.workspaceDir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const gitDir = join(dir, ".git");
    if (!existsSync(gitDir)) {
      const git = simpleGit();
      // Full clone (no --depth) so we have all refs
      await git.clone(this.remoteUrl(), dir);
    }

    this.git = simpleGit(dir);

    // Fetch specific branches to ensure refs exist
    const refsToFetch: string[] = [];
    if (sourceRef) refsToFetch.push(sourceRef);
    if (targetRef && targetRef !== sourceRef) refsToFetch.push(targetRef);

    if (refsToFetch.length > 0) {
      await this.git.fetch(["origin", ...refsToFetch, "--no-tags"]);
    } else {
      await this.git.fetch(["--all", "--prune"]);
    }
  }

  async checkout(branch: string): Promise<void> {
    if (!this.git) throw new Error("ensureRepo() must be called first");

    // Reset any uncommitted changes from previous bot runs
    await this.git.reset(["--hard"]);

    // Try to checkout and reset to remote
    try {
      await this.git.checkout(["-B", branch, `origin/${branch}`]);
    } catch {
      // Branch doesn't exist on remote yet, try local checkout
      try {
        await this.git.checkout(branch);
      } catch {
        // Create new branch
        await this.git.checkout(["-b", branch]);
      }
    }
  }

  async getDiff(baseRef: string, headRef: string): Promise<string> {
    if (!this.git) throw new Error("ensureRepo() must be called first");
    // Use two-dot syntax: changes from base to head
    return await this.git.diff([baseRef, headRef]);
  }

  async getChangedFiles(
    baseRef: string,
    headRef: string,
  ): Promise<string[]> {
    if (!this.git) throw new Error("ensureRepo() must be called first");
    const result = await this.git.diffSummary([baseRef, headRef]);
    return result.files.map((f) => f.file);
  }

  async getHeadSha(): Promise<string> {
    if (!this.git) throw new Error("ensureRepo() must be called first");
    const log = await this.git.log({ maxCount: 1 });
    return log.latest?.hash ?? "";
  }

  async lastCommitMessageContains(substring: string): Promise<boolean> {
    if (!this.git) throw new Error("ensureRepo() must be called first");
    const log = await this.git.log({ maxCount: 1 });
    const msg = log.latest?.message ?? "";
    return msg.includes(substring);
  }

  async getLastCommitMessage(): Promise<string> {
    if (!this.git) throw new Error("ensureRepo() must be called first");
    const log = await this.git.log({ maxCount: 1 });
    return log.latest?.message ?? "";
  }

  async getLastCommitAuthor(): Promise<{ name: string; email: string }> {
    if (!this.git) throw new Error("ensureRepo() must be called first");
    const log = await this.git.log({ maxCount: 1 });
    return {
      name: log.latest?.author_name ?? "",
      email: log.latest?.author_email ?? "",
    };
  }

  async removeFile(filePath: string): Promise<void> {
    if (!this.git) throw new Error("ensureRepo() must be called first");
    const fullPath = join(this.ctx.workspaceDir, filePath);
    if (existsSync(fullPath)) {
      await this.git.rm([filePath, "--cached", "--ignore-unmatch"]);
      try { unlinkSync(fullPath); } catch { /* ok */ }
    }
  }

  async applyFiles(
    files: { path: string; content: string }[],
  ): Promise<void> {
    for (const file of files) {
      const fullPath = join(this.ctx.workspaceDir, file.path);
      // Security: ensure path stays within workspace
      if (!fullPath.startsWith(this.ctx.workspaceDir)) {
        throw new Error(`Path traversal detected: ${file.path}`);
      }
      if (file.path.includes(".git/") || file.path === ".git") {
        throw new Error(`Cannot modify .git directory: ${file.path}`);
      }
      writeFileSync(fullPath, file.content, "utf-8");
    }
  }

  async hasChanges(): Promise<boolean> {
    if (!this.git) throw new Error("ensureRepo() must be called first");
    const status = await this.git.status();
    return !status.isClean();
  }

  async commitAndPush(
    message: string,
    author: { name: string; email: string },
    branch: string,
    files: string[],
  ): Promise<string> {
    if (!this.git) throw new Error("ensureRepo() must be called first");
    await this.git.addConfig("user.name", author.name);
    await this.git.addConfig("user.email", author.email);

    // Only stage the files we actually modified
    if (files.length > 0) {
      await this.git.add(files);
    } else {
      await this.git.add(".");
    }

    const commitResult = await this.git.commit(message);
    await this.git.push("origin", branch);
    return commitResult.commit ?? "";
  }
}
