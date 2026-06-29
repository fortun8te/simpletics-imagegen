# Telegram control design

Telegram becomes a thin control surface for the local ImageGen bridge. It reports only milestones, while commands query or change the same bridge queue the extension uses.

- `/status` shows project, completed, pending, failed, and current item.
- `/pause`, `/resume`, `/skip`, and `/retry <name>` change the queue without touching downloads.
- `/runs <name> <1-10>` changes a pending prompt’s desired run count before it starts.
- The bridge sends start, halfway, paused, blocked, and finished messages; it never pings per image.
- Only the configured Telegram chat is accepted. Without a configured bot token, the bridge continues normally and prints a clear local notice.
