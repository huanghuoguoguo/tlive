/**
 * Build the cron management system prompt fragment.
 *
 * Tells the agent about the cron REST API so it can manage scheduled tasks
 * on behalf of the user via WebFetch.
 */

export function buildCronSystemPrompt(webhookPort: number, webhookToken: string): string {
  const baseUrl = `http://localhost:${webhookPort}`;
  return `
## Scheduled Tasks (Cron)

You can manage scheduled tasks for the user via the tlive cron API.
When the user asks you to set up a recurring task (e.g., "每天9点帮我签到", "remind me to check deploys every morning"), use WebFetch to call these endpoints.

**Base URL:** ${baseUrl}
**Auth:** Bearer ${webhookToken}

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/cron/jobs | List all scheduled jobs |
| POST | /api/cron/jobs | Create a new job |
| GET | /api/cron/jobs/:id | Get a specific job |
| PUT | /api/cron/jobs/:id | Update a job |
| DELETE | /api/cron/jobs/:id | Delete a job |
| POST | /api/cron/jobs/:id/enable | Enable a job |
| POST | /api/cron/jobs/:id/disable | Disable a job |

### Create Job (POST /api/cron/jobs)

Required fields:
- \`name\`: Human-readable name
- \`schedule\`: Cron expression (5-field: minute hour day month weekday)
- \`prompt\`: The prompt that will be sent to a Claude session when triggered

Optional fields:
- \`channelType\`: Target IM channel (e.g., "telegram", "feishu")
- \`chatId\`: Target chat ID
- \`projectName\`: Route to a specific project
- \`workdir\`: Working directory for this job (absolute path). Use this to isolate the job's execution context.
- \`event\`: Display label for IM notification
- \`enabled\`: Whether job starts enabled (default: true)

### Working Directory Guidelines

You should decide the \`workdir\` based on the task nature:
- **Project-related tasks** (e.g., "每天跑一次测试", "检查代码质量"): Use the current project directory. No need to set \`workdir\`, it will inherit from the chat's current directory.
- **Independent tasks** (e.g., "每天签到", "定时备份"): Create a dedicated directory under \`~/.tlive/cron-tasks/<job-name>/\` and set \`workdir\` to that path. Put scripts and artifacts there to avoid polluting any project.

When creating an independent task:
1. Create the directory: \`mkdir -p ~/.tlive/cron-tasks/<job-name>\`
2. Place any needed scripts or config files there
3. Set \`workdir\` to the absolute path of that directory

### Cron Expression Format

Standard 5-field: \`minute hour day month weekday\`
- minute: 0-59 or *
- hour: 0-23 or *
- day: 1-31 or *
- month: 1-12 or *
- weekday: 0-6 (Sunday=0) or *

Examples: \`0 9 * * *\` (daily 9am), \`30 8 * * 1\` (Monday 8:30am), \`0 0 1 * *\` (1st of month midnight)

### Important Notes

- Jobs persist across bridge restarts (stored in ~/.tlive/runtime/cron-jobs.json).
- Use \`channelType\` and \`chatId\` from the current conversation to route the job's output back to the user.
- When the job triggers, a new Claude session will execute the prompt in the specified \`workdir\`.
`.trim();
}
