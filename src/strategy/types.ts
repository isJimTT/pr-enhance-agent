// Strategy input: provided by the bot to every strategy
export interface StrategyContext {
  traceId: string;
  route: string;
  event: {
    provider: string;
    action: string;
    sender: string;
    pr: {
      number: number;
      title: string;
      body: string;
      sourceBranch: string;
      targetBranch: string;
      headSha: string;
      url: string;
    };
  };
  repo: {
    fullName: string;
    workspaceDir: string;
  };
  git: {
    baseRef: string;
    headRef: string;
    diff: string;
    diffPath: string;
    changedFiles: string[];
  };
  env: Record<string, string>;
  targetFiles?: { path: string; currentContent: string }[];
}

// Strategy output: what the strategy returns
export type StrategyResult =
  | {
      action: "update";
      files: { path: string; content: string }[];
      message?: string;
    }
  | {
      action: "patch";
      patches: { path: string; sections: { heading: string; newContent: string }[] }[];
      message?: string;
      rawOutput?: string;
    }
  | { action: "no_change"; reason: string }
  | { action: "error"; reason: string };
