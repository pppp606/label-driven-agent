// src/poller.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

const execAsync = promisify(exec);

interface LabelConfig {
  command: string;
  args?: string[];
}

interface Config {
  github: {
    repo: string;
  };
  labels: Record<string, LabelConfig>;
}

class GitHubPoller {
  private config: Config;
  private processedFile = '.label-driven-agent.state.json';
  private processed: Set<string>;

  constructor() {
    const configPath = './github-poller.json';

    if (!fs.existsSync(configPath)) {
      throw new Error(
        `Config file not found: ${configPath}\n` +
        `Please copy github-poller.json.sample to github-poller.json and configure it.`
      );
    }

    const fileContents = fs.readFileSync(configPath, 'utf8');
    this.config = JSON.parse(fileContents) as Config;
    this.processed = this.loadProcessed();
  }

  private loadProcessed(): Set<string> {
    try {
      if (fs.existsSync(this.processedFile)) {
        const data = fs.readFileSync(this.processedFile, 'utf8');
        return new Set(JSON.parse(data));
      }
    } catch (e) {
      console.error('Error loading processed file:', e);
    }
    return new Set();
  }

  private saveProcessed(): void {
    if (this.processed.size > 1000) {
      const items = Array.from(this.processed);
      this.processed = new Set(items.slice(-500));
    }

    fs.writeFileSync(
      this.processedFile,
      JSON.stringify([...this.processed], null, 2)
    );
  }

  async poll(): Promise<void> {
    console.log(`[${new Date().toISOString()}] Polling ${this.config.github.repo}...`);

    try {
      const { stdout } = await execAsync(
        `gh issue list --repo ${this.config.github.repo} --state open --json number,title,body,labels --limit 100`
      );

      const issues = JSON.parse(stdout);
      console.log(`Found ${issues.length} open issues`);

      for (const issue of issues) {
        await this.processIssue(issue);
      }

      console.log('Polling completed\n');
    } catch (error: any) {
      console.error('Error during polling:', error.message);
    }
  }

  private async processIssue(issue: any): Promise<void> {
    const labels = issue.labels.map((l: any) => l.name);

    for (const label of labels) {
      const key = `${issue.number}-${label}`;

      if (this.processed.has(key)) {
        continue;
      }

      if (!(label in this.config.labels)) {
        continue;
      }

      console.log(`\n🔍 Found label '${label}' on issue #${issue.number}: ${issue.title}`);

      await this.executeCommand(label, issue);

      this.processed.add(key);
      this.saveProcessed();
    }
  }

  private async executeCommand(label: string, issue: any): Promise<void> {
    const labelConfig = this.config.labels[label];
    let { command, args = [] } = labelConfig;

    args = args.map(arg =>
      arg
        .replace('{issue_number}', issue.number.toString())
        .replace('{issue_title}', issue.title)
        .replace('{issue_body}', issue.body || '')
    );

    const fullCommand = `${command} ${args.join(' ')}`;
    console.log(`⚙️  Executing: ${fullCommand}`);

    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        env: {
          ...process.env,
          ISSUE_NUMBER: issue.number.toString(),
          ISSUE_TITLE: issue.title,
          ISSUE_BODY: issue.body || '',
          ISSUE_LABELS: issue.labels.map((l: any) => l.name).join(','),
        },
        timeout: 300000,
      });

      if (stdout) {
        console.log('📤 Output:', stdout.trim());
      }
      if (stderr) {
        console.error('⚠️  Stderr:', stderr.trim());
      }

      console.log(`✅ Command completed for issue #${issue.number}`);
    } catch (error: any) {
      console.error(`❌ Command failed for issue #${issue.number}:`, error.message);
    }
  }
}

const poller = new GitHubPoller();
poller.poll().catch(console.error);
