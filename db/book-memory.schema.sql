-- 书籍记忆库（books/<书名>/story/memory.db）：章节记忆/实体/事实检索
-- 仅结构，无数据。运行时由代码迁移自动建表，此文件用于查阅/审计。

CREATE TABLE chapter_summaries (
        chapter INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        characters TEXT NOT NULL DEFAULT '',
        events TEXT NOT NULL DEFAULT '',
        state_changes TEXT NOT NULL DEFAULT '',
        hook_activity TEXT NOT NULL DEFAULT '',
        mood TEXT NOT NULL DEFAULT '',
        chapter_type TEXT NOT NULL DEFAULT ''
      );

CREATE TABLE facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from_chapter INTEGER NOT NULL,
        valid_until_chapter INTEGER,
        source_chapter INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE hooks (
        hook_id TEXT PRIMARY KEY,
        start_chapter INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        last_advanced_chapter INTEGER NOT NULL DEFAULT 0,
        expected_payoff TEXT NOT NULL DEFAULT '',
        payoff_timing TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT ''
      );

CREATE INDEX idx_facts_source ON facts(source_chapter);

CREATE INDEX idx_facts_subject ON facts(subject);

CREATE INDEX idx_facts_valid ON facts(valid_from_chapter, valid_until_chapter);

CREATE INDEX idx_hooks_last_advanced ON hooks(last_advanced_chapter);

CREATE INDEX idx_hooks_status ON hooks(status);
