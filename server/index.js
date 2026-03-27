const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const PORT = Number(process.env.PORT || 3001);
const DEV_ORIGIN = process.env.DEV_ORIGIN || 'http://localhost:5173';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const DEFAULT_TOTAL_PLAYERS = 5;
const DEFAULT_REQUIRED_MAJORITY = 3;
const ACTIVE_PLAYER_WINDOW_MINUTES = 20;

const dbPath = path.join(__dirname, '..', 'data', 'byob.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: [DEV_ORIGIN],
    credentials: true,
  }),
);
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'byob-dev-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: 'lax',
    },
  }),
);

marked.setOptions({
  gfm: true,
  breaks: true,
});

function renderMarkdownSafe(markdown) {
  const dirty = marked.parse(markdown || '');
  return sanitizeHtml(dirty, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3', 'span']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      span: ['style'],
      a: ['href', 'name', 'target', 'rel'],
    },
    allowedStyles: {
      '*': {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb\((\d{1,3},\s*){2}\d{1,3}\)$/i, /^hsl\((\d{1,3},\s*){2}\d{1,3}%\)$/i, /^[a-z]+$/i],
      },
    },
  });
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      selection_limit INTEGER NOT NULL DEFAULT 3,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 120,
      y REAL NOT NULL DEFAULT 120,
      z_index INTEGER NOT NULL DEFAULT 1,
      selected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      board_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('addition', 'removal')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'passed', 'failed')),
      total_players INTEGER NOT NULL DEFAULT 5,
      required_majority INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vote_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote_id INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approve', 'deny')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (vote_id, player_id),
      FOREIGN KEY (vote_id) REFERENCES votes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS player_presence (
      player_id TEXT PRIMARY KEY,
      last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS session_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      is_paused INTEGER NOT NULL DEFAULT 0,
      pause_message TEXT NOT NULL DEFAULT 'Waiting for others',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tooltip_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      term TEXT NOT NULL,
      term_key TEXT NOT NULL,
      definition TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (board_id, term_key),
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS global_tooltip_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL,
      term_key TEXT NOT NULL UNIQUE,
      definition TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id);
    CREATE INDEX IF NOT EXISTS idx_votes_card ON votes(card_id);
    CREATE INDEX IF NOT EXISTS idx_votes_status ON votes(status);
    CREATE INDEX IF NOT EXISTS idx_tooltips_board ON tooltip_terms(board_id);
    CREATE INDEX IF NOT EXISTS idx_global_tooltips_key ON global_tooltip_terms(term_key);
  `);

  const boardCount = db.prepare('SELECT COUNT(*) AS c FROM boards').get().c;
  if (boardCount === 0) {
    const boardStmt = db.prepare(
      'INSERT INTO boards (title, question, selection_limit, is_active) VALUES (?, ?, ?, 1)',
    );
    const { lastInsertRowid } = boardStmt.run(
      'Hull Frame',
      'What should your ship include first?',
      3,
    );

    const seedCards = [
      {
        title: 'Reinforced Oak Hull',
        summary: 'Durable frame with strong ballast.',
        content:
          'A sturdy oak hull reinforced with iron ribs.\n\n**Benefit:** Better durability in rough seas.\n\n*Cost:* Heavier and slightly slower.',
      },
      {
        title: 'Arcane Lantern Network',
        summary: 'Permanent soft-light routes through the ship.',
        content:
          'Blue runed lanterns line corridors and decks.\n\nThis improves visibility and allows **night maneuvers** without open flame.',
      },
      {
        title: 'Hidden Smuggler Hold',
        summary: 'Concealed cargo bay with false wall.',
        content:
          'A hidden hold built behind a false storage room.\n\nUseful for secret cargo, surprise supplies, or contraband.',
      },
    ];

    const cardStmt = db.prepare(
      'INSERT INTO cards (board_id, title, summary, content, x, y, z_index, selected) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
    );

    seedCards.forEach((card, index) => {
      cardStmt.run(
        Number(lastInsertRowid),
        card.title,
        card.summary,
        card.content,
        120 + index * 180,
        150 + index * 40,
        index + 1,
      );
    });
  }

  db.prepare(
    `
    INSERT INTO session_state (id, is_paused, pause_message)
    VALUES (1, 0, 'Waiting for others')
    ON CONFLICT(id) DO NOTHING
    `,
  ).run();

  const globalTooltipCount = db.prepare('SELECT COUNT(*) AS c FROM global_tooltip_terms').get().c;
  if (!globalTooltipCount) {
    const legacyRows = db
      .prepare(
        `
        SELECT term, term_key, definition
        FROM tooltip_terms
        ORDER BY term_key ASC, id ASC
        `,
      )
      .all();

    if (legacyRows.length > 0) {
      const insertGlobal = db.prepare(
        `
        INSERT INTO global_tooltip_terms (term, term_key, definition)
        VALUES (?, ?, ?)
        `,
      );
      const seen = new Set();

      legacyRows.forEach((row) => {
        const key = String(row.term_key || '').trim().toLowerCase();
        const term = String(row.term || '').trim();
        const definition = String(row.definition || '').trim();
        if (!key || !term || !definition || seen.has(key)) {
          return;
        }

        seen.add(key);
        insertGlobal.run(term, key, definition);
      });
    }
  }
}

ensureSchema();

function touchPlayer(playerId) {
  const normalized = String(playerId || '').trim();
  if (!normalized) {
    return;
  }

  db.prepare(
    `
    INSERT INTO player_presence (player_id, last_seen)
    VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(player_id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP
    `,
  ).run(normalized);
}

function disconnectPlayer(playerId) {
  const normalized = String(playerId || '').trim();
  if (!normalized) {
    return;
  }

  db.prepare('DELETE FROM player_presence WHERE player_id = ?').run(normalized);
}

function cleanupStalePlayers() {
  db.prepare(
    `
    DELETE FROM player_presence
    WHERE datetime(last_seen) < datetime('now', ?)
    `,
  ).run(`-${ACTIVE_PLAYER_WINDOW_MINUTES} minutes`);
}

function getActivePlayerIds() {
  cleanupStalePlayers();
  return db
    .prepare(
      `
      SELECT player_id
      FROM player_presence
      WHERE datetime(last_seen) >= datetime('now', ?)
      ORDER BY datetime(last_seen) DESC
      `,
    )
    .all(`-${ACTIVE_PLAYER_WINDOW_MINUTES} minutes`)
    .map((row) => row.player_id);
}

function getSessionState() {
  const row = db
    .prepare('SELECT is_paused, pause_message FROM session_state WHERE id = 1')
    .get();

  return {
    isPaused: Boolean(row?.is_paused),
    message: String(row?.pause_message || 'Waiting for others'),
  };
}

function setSessionPaused(isPaused, message) {
  db.prepare(
    `
    UPDATE session_state
    SET is_paused = ?,
        pause_message = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
    `,
  ).run(isPaused ? 1 : 0, String(message || 'Waiting for others'));
}

function getVotingThreshold() {
  const activePlayers = getActivePlayerIds().length;
  const totalPlayers = Math.max(1, activePlayers || DEFAULT_TOTAL_PLAYERS);
  const requiredMajority = Math.floor(totalPlayers / 2) + 1;
  return {
    totalPlayers,
    requiredMajority,
  };
}

function getActiveBoard() {
  return db.prepare('SELECT * FROM boards WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
}

function getGlobalTooltipTerms() {
  return db
    .prepare(
      `
      SELECT term, definition
      FROM global_tooltip_terms
      ORDER BY term_key ASC
      `,
    )
    .all()
    .map((row) => ({
      term: String(row.term || ''),
      definition: String(row.definition || ''),
    }));
}

function replaceGlobalTooltipTerms(terms) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM global_tooltip_terms').run();

    const insert = db.prepare(
      `
      INSERT INTO global_tooltip_terms (term, term_key, definition)
      VALUES (?, ?, ?)
      `,
    );

    terms.forEach((entry) => {
      insert.run(entry.term, entry.termKey, entry.definition);
    });
  });

  tx();
}

function getCardsByBoard(boardId) {
  return db
    .prepare(
      `
      SELECT
        c.*,
        v.id AS vote_id,
        v.type AS vote_type,
        v.status AS vote_status,
        v.required_majority,
        v.total_players
      FROM cards c
      LEFT JOIN votes v
        ON v.card_id = c.id
        AND v.status = 'open'
      WHERE c.board_id = ?
      ORDER BY c.z_index ASC, c.id ASC
      `,
    )
    .all(boardId)
    .map((row) => {
      const card = {
        id: row.id,
        boardId: row.board_id,
        title: row.title,
        summary: row.summary,
        content: row.content,
        renderedContent: renderMarkdownSafe(row.content),
        x: row.x,
        y: row.y,
        zIndex: row.z_index,
        selected: Boolean(row.selected),
        openVote: null,
      };

      if (row.vote_id) {
        const responses = db
          .prepare('SELECT player_id, decision FROM vote_responses WHERE vote_id = ?')
          .all(row.vote_id);

        card.openVote = {
          id: row.vote_id,
          type: row.vote_type,
          status: row.vote_status,
          requiredMajority: row.required_majority,
          totalPlayers: row.total_players,
          responses: responses,
          approveCount: responses.filter((vote) => vote.decision === 'approve').length,
          denyCount: responses.filter((vote) => vote.decision === 'deny').length,
        };
      }

      return card;
    });
}

function getStatePayload() {
  const activePlayerIds = getActivePlayerIds();
  const { totalPlayers, requiredMajority } = getVotingThreshold();
  const session = getSessionState();
  const activeBoard = getActiveBoard();
  if (!activeBoard) {
    return {
      board: null,
      cards: [],
      tooltipTerms: getGlobalTooltipTerms(),
      players: totalPlayers,
      requiredMajority,
      activePlayerIds,
      session,
    };
  }

  const cards = getCardsByBoard(activeBoard.id);
  return {
    board: {
      id: activeBoard.id,
      title: activeBoard.title,
      question: activeBoard.question,
      selectionLimit: activeBoard.selection_limit,
    },
    cards,
    tooltipTerms: getGlobalTooltipTerms(),
    players: totalPlayers,
    requiredMajority,
    activePlayerIds,
    session,
  };
}

function updateVoteStatus(voteId) {
  const vote = db.prepare('SELECT * FROM votes WHERE id = ?').get(voteId);
  if (!vote || vote.status !== 'open') {
    return;
  }

  const responses = db
    .prepare('SELECT decision FROM vote_responses WHERE vote_id = ?')
    .all(voteId);
  const approveCount = responses.filter((response) => response.decision === 'approve').length;
  const denyCount = responses.filter((response) => response.decision === 'deny').length;
  const remaining = vote.total_players - responses.length;

  let status = 'open';
  if (approveCount >= vote.required_majority) {
    status = 'passed';
  } else if (denyCount >= vote.required_majority) {
    status = 'failed';
  } else if (approveCount + remaining < vote.required_majority) {
    status = 'failed';
  }

  if (status === 'open') {
    return;
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE votes SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, voteId);

    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(vote.card_id);
    if (!card) {
      return;
    }

    if (status === 'passed') {
      if (vote.type === 'addition') {
        const selectedCount = db
          .prepare('SELECT COUNT(*) AS c FROM cards WHERE board_id = ? AND selected = 1')
          .get(vote.board_id).c;

        if (selectedCount >= db.prepare('SELECT selection_limit FROM boards WHERE id = ?').get(vote.board_id).selection_limit) {
          db.prepare('UPDATE votes SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?').run('failed', voteId);
          return;
        }

        db.prepare('UPDATE cards SET selected = 1 WHERE id = ?').run(vote.card_id);
      }

      if (vote.type === 'removal') {
        db.prepare('UPDATE cards SET selected = 0 WHERE id = ?').run(vote.card_id);
      }
    }
  });

  tx();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    res.status(401).json({ error: 'Admin login required.' });
    return;
  }
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, system: 'BYOB' });
});

app.get('/api/game-state', (_req, res) => {
  touchPlayer(_req.query.playerId);
  res.json(getStatePayload());
});

app.post('/api/players/disconnect', (req, res) => {
  const playerId = String(req.body.playerId || '');
  if (!playerId) {
    res.status(400).json({ error: 'playerId is required.' });
    return;
  }

  disconnectPlayer(playerId);
  res.json({ ok: true });
});

app.post('/api/cards/:id/move', (req, res) => {
  if (getSessionState().isPaused) {
    res.status(423).json({ error: 'Session is paused.' });
    return;
  }

  const id = Number(req.params.id);
  const x = Number(req.body.x);
  const y = Number(req.body.y);
  const zIndex = Number(req.body.zIndex || 1);

  if (!Number.isFinite(id) || !Number.isFinite(x) || !Number.isFinite(y)) {
    res.status(400).json({ error: 'Invalid card position payload.' });
    return;
  }

  db.prepare('UPDATE cards SET x = ?, y = ?, z_index = ? WHERE id = ?').run(x, y, zIndex, id);
  res.json({ ok: true });
});

app.post('/api/cards/:id/suggest-addition', (req, res) => {
  if (getSessionState().isPaused) {
    res.status(423).json({ error: 'Session is paused.' });
    return;
  }

  const cardId = Number(req.params.id);
  const playerId = String(req.body.playerId || '');
  
  if (!playerId) {
    res.status(400).json({ error: 'playerId is required.' });
    return;
  }
  touchPlayer(playerId);
  
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) {
    res.status(404).json({ error: 'Card not found.' });
    return;
  }
  if (card.selected) {
    res.status(400).json({ error: 'Card is already selected.' });
    return;
  }

  const board = db.prepare('SELECT selection_limit FROM boards WHERE id = ?').get(card.board_id);
  const selectedCount = db
    .prepare('SELECT COUNT(*) AS c FROM cards WHERE board_id = ? AND selected = 1')
    .get(card.board_id).c;
  if (selectedCount >= Number(board?.selection_limit || 0)) {
    res.status(400).json({ error: 'Options full! Remove one to suggest another.' });
    return;
  }

  const existing = db
    .prepare('SELECT * FROM votes WHERE card_id = ? AND status = ?')
    .get(cardId, 'open');
  if (existing) {
    res.status(400).json({ error: 'This card already has an active vote.' });
    return;
  }

  // Create vote with this player already approving it
  const tx = db.transaction(() => {
    const threshold = getVotingThreshold();
    const result = db.prepare(
      `
      INSERT INTO votes (card_id, board_id, type, status, total_players, required_majority)
      VALUES (?, ?, 'addition', 'open', ?, ?)
      `,
    ).run(cardId, card.board_id, threshold.totalPlayers, threshold.requiredMajority);
    
    const voteId = Number(result.lastInsertRowid);
    
    // Have the suggesting player automatically approve
    db.prepare(
      `
      INSERT INTO vote_responses (vote_id, player_id, decision)
      VALUES (?, ?, 'approve')
      `,
    ).run(voteId, playerId);
    
    // Check if vote is complete
    updateVoteStatus(voteId);
  });

  tx();
  res.json(getStatePayload());
});

app.post('/api/cards/:id/suggest-removal', (req, res) => {
  if (getSessionState().isPaused) {
    res.status(423).json({ error: 'Session is paused.' });
    return;
  }

  const cardId = Number(req.params.id);
  const playerId = String(req.body.playerId || '');
  
  if (!playerId) {
    res.status(400).json({ error: 'playerId is required.' });
    return;
  }
  touchPlayer(playerId);
  
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) {
    res.status(404).json({ error: 'Card not found.' });
    return;
  }
  if (!card.selected) {
    res.status(400).json({ error: 'Card is not selected yet.' });
    return;
  }

  const existing = db
    .prepare('SELECT * FROM votes WHERE card_id = ? AND status = ?')
    .get(cardId, 'open');
  if (existing) {
    res.status(400).json({ error: 'This card already has an active vote.' });
    return;
  }

  // Create vote with this player already approving it
  const tx = db.transaction(() => {
    const threshold = getVotingThreshold();
    const result = db.prepare(
      `
      INSERT INTO votes (card_id, board_id, type, status, total_players, required_majority)
      VALUES (?, ?, 'removal', 'open', ?, ?)
      `,
    ).run(cardId, card.board_id, threshold.totalPlayers, threshold.requiredMajority);
    
    const voteId = Number(result.lastInsertRowid);
    
    // Have the suggesting player automatically approve
    db.prepare(
      `
      INSERT INTO vote_responses (vote_id, player_id, decision)
      VALUES (?, ?, 'approve')
      `,
    ).run(voteId, playerId);
    
    // Check if vote is complete
    updateVoteStatus(voteId);
  });

  tx();
  res.json(getStatePayload());
});

app.post('/api/votes/:id/respond', (req, res) => {
  if (getSessionState().isPaused) {
    res.status(423).json({ error: 'Session is paused.' });
    return;
  }

  const voteId = Number(req.params.id);
  const playerId = String(req.body.playerId || '');
  const decision = String(req.body.decision || '');

  if (!playerId) {
    res.status(400).json({ error: 'playerId is required.' });
    return;
  }
  touchPlayer(playerId);

  if (decision !== 'approve' && decision !== 'deny') {
    res.status(400).json({ error: 'decision must be approve or deny.' });
    return;
  }

  const vote = db.prepare('SELECT * FROM votes WHERE id = ?').get(voteId);
  if (!vote || vote.status !== 'open') {
    res.status(404).json({ error: 'Vote is not open.' });
    return;
  }

  db.prepare(
    `
    INSERT INTO vote_responses (vote_id, player_id, decision)
    VALUES (?, ?, ?)
    ON CONFLICT(vote_id, player_id) DO UPDATE SET decision = excluded.decision
    `,
  ).run(voteId, playerId, decision);

  updateVoteStatus(voteId);
  res.json(getStatePayload());
});

app.post('/api/admin/login', (req, res) => {
  const password = String(req.body.password || '');
  const ok = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);

  if (!ok) {
    res.status(401).json({ error: 'Invalid admin password.' });
    return;
  }

  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/admin/status', (req, res) => {
  res.json({ isAdmin: Boolean(req.session.isAdmin) });
});

app.get('/api/admin/boards', requireAdmin, (_req, res) => {
  const boards = db
    .prepare('SELECT * FROM boards ORDER BY is_active DESC, id DESC')
    .all()
    .map((board) => ({
      id: board.id,
      title: board.title,
      question: board.question,
      selectionLimit: board.selection_limit,
      isActive: Boolean(board.is_active),
    }));

  res.json({ boards });
});

app.post('/api/admin/boards', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim();
  const question = String(req.body.question || '').trim();
  const selectionLimit = Number(req.body.selectionLimit || 3);

  if (!title || !question || !Number.isFinite(selectionLimit) || selectionLimit <= 0) {
    res.status(400).json({ error: 'title, question, and positive selectionLimit are required.' });
    return;
  }

  const result = db
    .prepare('INSERT INTO boards (title, question, selection_limit, is_active) VALUES (?, ?, ?, 0)')
    .run(title, question, selectionLimit);

  res.json({ id: Number(result.lastInsertRowid) });
});

app.post('/api/admin/swap-board', requireAdmin, (req, res) => {
  const boardId = Number(req.body.boardId);
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
  if (!board) {
    res.status(404).json({ error: 'Board not found.' });
    return;
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE boards SET is_active = 0').run();
    db.prepare('UPDATE boards SET is_active = 1 WHERE id = ?').run(boardId);
  });

  tx();

  res.json(getStatePayload());
});

app.delete('/api/admin/boards/:id', requireAdmin, (req, res) => {
  const boardId = Number(req.params.id);
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
  if (!board) {
    res.status(404).json({ error: 'Board not found.' });
    return;
  }

  const boardCount = db.prepare('SELECT COUNT(*) AS c FROM boards').get().c;
  if (boardCount <= 1) {
    res.status(400).json({ error: 'Cannot delete last board' });
    return;
  }

  const tx = db.transaction(() => {
    const cardIds = db.prepare('SELECT id FROM cards WHERE board_id = ?').all(boardId).map((row) => row.id);
    cardIds.forEach((card) => {
      const votes = db.prepare('SELECT id FROM votes WHERE card_id = ?').all(card.id);
      votes.forEach((vote) => {
        db.prepare('DELETE FROM vote_responses WHERE vote_id = ?').run(vote.id);
      });
      db.prepare('DELETE FROM votes WHERE card_id = ?').run(card.id);
    });

    db.prepare('DELETE FROM cards WHERE board_id = ?').run(boardId);
    db.prepare('DELETE FROM boards WHERE id = ?').run(boardId);

    const hasActive = db.prepare('SELECT COUNT(*) AS c FROM boards WHERE is_active = 1').get().c;
    if (!hasActive) {
      const remainingBoards = db.prepare('SELECT id FROM boards').all();
      if (remainingBoards.length > 0) {
        const randomIndex = Math.floor(Math.random() * remainingBoards.length);
        db.prepare('UPDATE boards SET is_active = 1 WHERE id = ?').run(remainingBoards[randomIndex].id);
      }
    }
  });

  tx();
  res.json({ ok: true });
});

app.post('/api/admin/cards', requireAdmin, (req, res) => {
  const boardId = Number(req.body.boardId);
  const title = String(req.body.title || '').trim();
  const summary = String(req.body.summary || '').trim();
  const content = String(req.body.content || '').trim();

  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
  if (!board) {
    res.status(404).json({ error: 'Board not found.' });
    return;
  }

  if (!title || !summary || !content) {
    res.status(400).json({ error: 'title, summary, and content are required.' });
    return;
  }

  const highestZ =
    db.prepare('SELECT COALESCE(MAX(z_index), 0) AS z FROM cards WHERE board_id = ?').get(boardId).z || 0;

  const result = db
    .prepare(
      `
      INSERT INTO cards (board_id, title, summary, content, x, y, z_index, selected)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `,
    )
    .run(boardId, title, summary, content, 120 + (highestZ % 4) * 150, 140 + (highestZ % 3) * 90, highestZ + 1);

  res.json({ id: Number(result.lastInsertRowid) });
});

app.get('/api/admin/boards/:id/cards', requireAdmin, (req, res) => {
  const boardId = Number(req.params.id);
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
  if (!board) {
    res.status(404).json({ error: 'Board not found.' });
    return;
  }

  const cards = db
    .prepare(
      `
      SELECT id, board_id, title, summary, content, x, y, z_index, selected, created_at
      FROM cards
      WHERE board_id = ?
      ORDER BY z_index ASC, id ASC
      `,
    )
    .all(boardId)
    .map((card) => ({
      id: card.id,
      boardId: card.board_id,
      title: card.title,
      summary: card.summary,
      content: card.content,
      x: card.x,
      y: card.y,
      zIndex: card.z_index,
      selected: Boolean(card.selected),
      createdAt: card.created_at,
    }));

  res.json({ cards });
});

function normalizeTooltipTermsPayload(incoming) {
  const entries = Array.isArray(incoming) ? incoming : null;
  if (!entries) {
    return null;
  }

  const normalized = [];
  const seen = new Set();
  for (const raw of entries) {
    const term = String(raw?.term || '').trim();
    const definition = String(raw?.definition || '').trim();
    if (!term || !definition) {
      continue;
    }

    const termKey = term.toLowerCase();
    if (seen.has(termKey)) {
      continue;
    }

    seen.add(termKey);
    normalized.push({ term, termKey, definition });
  }

  return normalized;
}

app.get('/api/admin/tooltips', requireAdmin, (_req, res) => {
  res.json({ terms: getGlobalTooltipTerms() });
});

app.put('/api/admin/tooltips', requireAdmin, (req, res) => {
  const normalized = normalizeTooltipTermsPayload(req.body?.terms);
  if (!normalized) {
    res.status(400).json({ error: 'terms array is required.' });
    return;
  }

  replaceGlobalTooltipTerms(normalized);
  res.json({ terms: getGlobalTooltipTerms() });
});

// Legacy board-scoped routes retained for compatibility.
app.get('/api/admin/boards/:id/tooltips', requireAdmin, (_req, res) => {
  res.json({ terms: getGlobalTooltipTerms() });
});

app.put('/api/admin/boards/:id/tooltips', requireAdmin, (req, res) => {
  const normalized = normalizeTooltipTermsPayload(req.body?.terms);
  if (!normalized) {
    res.status(400).json({ error: 'terms array is required.' });
    return;
  }

  replaceGlobalTooltipTerms(normalized);
  res.json({ terms: getGlobalTooltipTerms() });
});

app.patch('/api/admin/cards/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const title = String(req.body.title || '').trim();
  const summary = String(req.body.summary || '').trim();
  const content = String(req.body.content || '').trim();

  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) {
    res.status(404).json({ error: 'Card not found.' });
    return;
  }

  db.prepare('UPDATE cards SET title = ?, summary = ?, content = ? WHERE id = ?').run(
    title || card.title,
    summary || card.summary,
    content || card.content,
    id,
  );

  res.json({ ok: true });
});

app.delete('/api/admin/cards/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) {
    res.status(404).json({ error: 'Card not found.' });
    return;
  }

  const tx = db.transaction(() => {
    const votes = db.prepare('SELECT id FROM votes WHERE card_id = ?').all(id);
    votes.forEach((vote) => {
      db.prepare('DELETE FROM vote_responses WHERE vote_id = ?').run(vote.id);
    });
    db.prepare('DELETE FROM votes WHERE card_id = ?').run(id);
    db.prepare('DELETE FROM cards WHERE id = ?').run(id);
  });

  tx();
  res.json({ ok: true });
});

app.post('/api/admin/preview', requireAdmin, (req, res) => {
  const content = String(req.body.content || '');
  res.json({ html: renderMarkdownSafe(content) });
});

app.get('/api/admin/open-votes', requireAdmin, (_req, res) => {
  const votes = db
    .prepare(
      `
      SELECT
        v.id,
        v.type,
        v.created_at,
        c.title AS card_title,
        b.title AS board_title
      FROM votes v
      JOIN cards c ON c.id = v.card_id
      JOIN boards b ON b.id = v.board_id
      WHERE v.status = 'open'
      ORDER BY v.created_at DESC
      `,
    )
    .all()
    .map((vote) => {
      const responses = db
        .prepare('SELECT player_id, decision FROM vote_responses WHERE vote_id = ? ORDER BY created_at ASC')
        .all(vote.id);
      return {
        id: vote.id,
        type: vote.type,
        cardTitle: vote.card_title,
        boardTitle: vote.board_title,
        createdAt: vote.created_at,
        responses,
      };
    });

  res.json({ votes });
});

app.post('/api/admin/votes/:id/terminate', requireAdmin, (req, res) => {
  const voteId = Number(req.params.id);
  const vote = db.prepare('SELECT * FROM votes WHERE id = ?').get(voteId);
  if (!vote || vote.status !== 'open') {
    res.status(404).json({ error: 'Open vote not found.' });
    return;
  }

  db.prepare("UPDATE votes SET status = 'failed', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(voteId);
  res.json({ ok: true });
});

app.get('/api/admin/session-state', requireAdmin, (_req, res) => {
  res.json(getSessionState());
});

app.post('/api/admin/session-state', requireAdmin, (req, res) => {
  const isPaused = Boolean(req.body.isPaused);
  const message = String(req.body.message || 'Waiting for others').trim() || 'Waiting for others';
  setSessionPaused(isPaused, message);
  res.json(getSessionState());
});

app.get('/api/admin/active-players', requireAdmin, (_req, res) => {
  const players = getActivePlayerIds();
  res.json({
    count: players.length,
    players,
    activeWindowMinutes: ACTIVE_PLAYER_WINDOW_MINUTES,
  });
});

app.post('/api/admin/wipe-players', requireAdmin, (_req, res) => {
  db.prepare('DELETE FROM player_presence').run();
  res.json({ ok: true });
});

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`BYOB server running on http://localhost:${PORT}`);
});
