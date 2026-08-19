-- 互动世界运行库（worlds/<id>/runs/<run>/play.db）：开放世界游玩状态
-- 仅结构，无数据。运行时由代码迁移自动建表，此文件用于查阅/审计。

CREATE TABLE edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        value_json TEXT NOT NULL DEFAULT '{}',
        valid_from_event TEXT NOT NULL,
        valid_until_event TEXT,
        source_event_id TEXT NOT NULL,
        visibility_json TEXT NOT NULL DEFAULT '{}',
        strength REAL,
        confidence REAL
      );

CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        created_event TEXT,
        updated_event TEXT
      );

CREATE TABLE events (
        id TEXT PRIMARY KEY,
        turn INTEGER NOT NULL,
        action_kind TEXT NOT NULL,
        raw_input TEXT NOT NULL,
        outcome_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

CREATE TABLE state_slots (
        id TEXT PRIMARY KEY,
        owner_entity_id TEXT,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_event TEXT NOT NULL
      );

CREATE INDEX idx_play_edges_from ON edges(from_id, valid_until_event);

CREATE INDEX idx_play_edges_to ON edges(to_id, type, valid_until_event);

CREATE INDEX idx_play_events_turn ON events(turn);

CREATE INDEX idx_play_state_owner ON state_slots(owner_entity_id);
