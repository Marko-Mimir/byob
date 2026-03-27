import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const LOADER_LINES = [
  '[VEXWELDA EASTMAN TERMINAL] boot sequence initialized...',
  'mounting /sys/byob/core... OK',
  'probing harbor architecture matrix... OK',
  'loading vote daemon (dynamic clients)... OK',
  'synchronizing card engine... OK',
  'BYOB: Build Your Own Boat ready.',
];

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function api(path, options = {}) {
  return fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Request failed');
    }
    return payload;
  });
}

const MC_COLORS = {
  '0': '#000000',
  '1': '#0000aa',
  '2': '#00aa00',
  '3': '#00aaaa',
  '4': '#aa0000',
  '5': '#aa00aa',
  '6': '#ffaa00',
  '7': '#aaaaaa',
  '8': '#555555',
  '9': '#5555ff',
  a: '#55ff55',
  b: '#55ffff',
  c: '#ff5555',
  d: '#ff55ff',
  e: '#ffff55',
  f: '#ffffff',
};

const MC_FORMAT_CODES = new Set(['l', 'm', 'n', 'o', 'r']);

function normalizeTooltipTerms(terms) {
  const map = new Map();
  (terms || []).forEach((entry) => {
    const term = String(entry?.term || '').trim();
    const definition = String(entry?.definition || '').trim();
    if (!term || !definition) {
      return;
    }

    map.set(term.toLowerCase(), {
      term,
      definition,
    });
  });
  return map;
}

function formatStateToStyle(state) {
  return {
    color: state.color || undefined,
    fontWeight: state.bold ? 700 : undefined,
    fontStyle: state.italic ? 'italic' : undefined,
    textDecoration: `${state.underline ? 'underline' : ''} ${state.strikethrough ? 'line-through' : ''}`.trim() || undefined,
  };
}

function parseMinecraftText(content, tooltipMap, onTooltipEnter, onTooltipLeave, keyPrefix = 'mc') {
  const text = String(content || '');
  const nodes = [];
  let keyIndex = 0;
  let styleState = {
    color: null,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
  };
  let buffer = '';

  function pushText(runText) {
    if (!runText) {
      return;
    }

    nodes.push(
      <span key={`${keyPrefix}-text-${keyIndex++}`} style={formatStateToStyle(styleState)}>
        {runText}
      </span>,
    );
  }

  function flushBuffer() {
    if (!buffer) {
      return;
    }
    pushText(buffer);
    buffer = '';
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '\\' && next === '&') {
      buffer += '&';
      i += 1;
      continue;
    }

    if (char === '&' && next) {
      const code = next.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(MC_COLORS, code) || MC_FORMAT_CODES.has(code)) {
        flushBuffer();
        if (Object.prototype.hasOwnProperty.call(MC_COLORS, code)) {
          styleState = {
            ...styleState,
            color: MC_COLORS[code],
          };
        } else if (code === 'l') {
          styleState = { ...styleState, bold: true };
        } else if (code === 'm') {
          styleState = { ...styleState, strikethrough: true };
        } else if (code === 'n') {
          styleState = { ...styleState, underline: true };
        } else if (code === 'o') {
          styleState = { ...styleState, italic: true };
        } else if (code === 'r') {
          styleState = {
            color: null,
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
          };
        }
        i += 1;
        continue;
      }
    }

    if (char === '[') {
      const closeIndex = text.indexOf(']', i + 1);
      if (closeIndex > i + 1) {
        const tooltipKey = text.slice(i + 1, closeIndex).trim().toLowerCase();
        const tooltip = tooltipMap.get(tooltipKey);
        if (tooltip) {
          flushBuffer();
          nodes.push(
            <span
              key={`${keyPrefix}-term-${keyIndex++}`}
              className="tooltip-term"
              style={formatStateToStyle(styleState)}
              onMouseEnter={(event) => onTooltipEnter(tooltip.term, event.currentTarget, event)}
              onMouseLeave={onTooltipLeave}
            >
              {tooltip.term}
            </span>,
          );
          i = closeIndex;
          continue;
        }
      }
    }

    if (char === '\n') {
      flushBuffer();
      nodes.push(<br key={`${keyPrefix}-br-${keyIndex++}`} />);
      continue;
    }

    buffer += char;
  }

  flushBuffer();
  return nodes;
}

function TooltipRichText({ content, terms, className = '' }) {
  const tooltipMap = useMemo(() => normalizeTooltipTerms(terms), [terms]);
  const [tooltipStack, setTooltipStack] = useState([]);
  const hideTimerRef = useRef(null);

  function clearHideTimer() {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }

  function scheduleHide() {
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => {
      setTooltipStack([]);
      hideTimerRef.current = null;
    }, 3000);
  }

  function keepOpen() {
    clearHideTimer();
  }

  function getTooltipPosition(anchorRect, anchorPoint, stackIndex) {
    const width = 320;
    const margin = 12;
    const verticalOffset = 2;
    const stackOffset = 4;
    const pointX = Number.isFinite(anchorPoint?.x) ? anchorPoint.x : anchorRect.left + anchorRect.width / 2;
    const pointY = Number.isFinite(anchorPoint?.y) ? anchorPoint.y : anchorRect.bottom;

    let left = pointX - width / 2;
    let top = pointY + verticalOffset;

    if (left + width + margin > window.innerWidth) {
      left = window.innerWidth - width - margin;
    }
    if (left < margin) {
      left = margin;
    }

    if (top + 220 > window.innerHeight) {
      top = Math.max(margin, pointY - 220 - verticalOffset);
    }

    return {
      left,
      top: top + stackIndex * stackOffset,
    };
  }

  function openTooltip(term, anchorElement, event) {
    const normalizedTerm = String(term || '').trim().toLowerCase();
    const tooltip = tooltipMap.get(normalizedTerm);
    if (!tooltip || !anchorElement) {
      return;
    }

    keepOpen();
    const anchorRect = anchorElement.getBoundingClientRect();
    const anchorPoint = {
      x: Number.isFinite(event?.clientX) ? event.clientX : anchorRect.left + anchorRect.width / 2,
      y: Number.isFinite(event?.clientY) ? event.clientY : anchorRect.bottom,
    };

    setTooltipStack((current) => {
      const existingIndex = current.findIndex((entry) => entry.anchorElement === anchorElement);
      if (existingIndex >= 0) {
        return current.map((entry, index) => {
          if (index !== existingIndex) {
            return entry;
          }

          return {
            ...entry,
            anchorRect,
            anchorPoint,
          };
        }).slice(0, existingIndex + 1);
      }

      return [
        ...current,
        {
          id: `${normalizedTerm}-${Date.now()}-${Math.random()}`,
          term: tooltip.term,
          definition: tooltip.definition,
          anchorElement,
          anchorRect,
          anchorPoint,
        },
      ];
    });
  }

  useEffect(
    () => () => {
      clearHideTimer();
    },
    [],
  );

  return (
    <div className={`tooltip-richtext ${className}`} onMouseEnter={keepOpen} onMouseLeave={scheduleHide}>
      <div className="formatted-text">{parseMinecraftText(content, tooltipMap, openTooltip, scheduleHide, 'content')}</div>

      {tooltipStack.map((tip, index) => {
        const position = getTooltipPosition(tip.anchorRect, tip.anchorPoint, index);
        return (
          <aside
            key={tip.id}
            className="term-tooltip-card"
            style={{ left: `${position.left}px`, top: `${position.top}px` }}
            onMouseEnter={keepOpen}
            onMouseLeave={scheduleHide}
          >
            <p className="term-tooltip-title">{tip.term}</p>
            <div className="formatted-text tooltip-definition">
              {parseMinecraftText(tip.definition, tooltipMap, openTooltip, scheduleHide, `tip-${tip.id}`)}
            </div>
          </aside>
        );
      })}
    </div>
  );
}

function Boot({ onFinish }) {
  const [loadingIndex, setLoadingIndex] = useState(0);

  useEffect(() => {
    const lineTimer = setInterval(() => {
      setLoadingIndex((idx) => {
        const next = idx + 1;
        if (next >= LOADER_LINES.length) {
          clearInterval(lineTimer);
          setTimeout(() => onFinish(), 450);
          return LOADER_LINES.length;
        }
        return next;
      });
    }, 340);

    return () => clearInterval(lineTimer);
  }, [onFinish]);

  return (
    <main className="boot-screen">
      <h1>BYOB // Build Your Own Boat</h1>
      <p className="subline">Engineered for harbor strategy by Vexwelda Eastman</p>
      <div className="terminal-window">
        {LOADER_LINES.slice(0, loadingIndex).map((line) => (
          <p key={line}>{line}</p>
        ))}
        {loadingIndex < LOADER_LINES.length ? <span className="cursor">_</span> : null}
      </div>
    </main>
  );
}

function PlayerView({ playerId }) {
  const [state, setState] = useState({ board: null, cards: [] });
  const [activeCardId, setActiveCardId] = useState(null);
  const [error, setError] = useState('');
  const [slotWarning, setSlotWarning] = useState('');
  const [localCardPositions, setLocalCardPositions] = useState({});
  const [questionText, setQuestionText] = useState('');
  const [questionVisibleCount, setQuestionVisibleCount] = useState(0);
  const [questionPhase, setQuestionPhase] = useState('hidden');
  const prevBoardIdRef = useRef(null);
  const prevPausedRef = useRef(undefined);
  const didShowInitialQuestionRef = useRef(false);

  useEffect(() => {
    fetchState();
    const poll = setInterval(fetchState, 3500);
    return () => clearInterval(poll);
  }, [playerId]);

  useEffect(() => {
    function notifyDisconnect() {
      const payload = JSON.stringify({ playerId });

      // Keepalive request for modern browsers, beacon fallback for page teardown.
      fetch('/api/players/disconnect', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: payload,
        keepalive: true,
      }).catch(() => {});

      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/players/disconnect', blob);
      }
    }

    window.addEventListener('pagehide', notifyDisconnect);
    window.addEventListener('beforeunload', notifyDisconnect);

    return () => {
      notifyDisconnect();
      window.removeEventListener('pagehide', notifyDisconnect);
      window.removeEventListener('beforeunload', notifyDisconnect);
    };
  }, [playerId]);

  async function fetchState() {
    try {
      const payload = await api(`/api/game-state?playerId=${encodeURIComponent(playerId)}`);
      setState(payload);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function suggestVote(card, type) {
    try {
      const endpoint = type === 'addition' ? 'suggest-addition' : 'suggest-removal';
      const payload = await api(`/api/cards/${card.id}/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify({ playerId }),
      });
      setState(payload);
      setActiveCardId(card.id);
      setSlotWarning('');
      setError('');
    } catch (err) {
      if (String(err.message).includes('Options full!')) {
        setSlotWarning(err.message);
      } else {
        setSlotWarning('');
      }
      setError(err.message);
    }
  }

  async function respondVote(voteId, decision) {
    try {
      const payload = await api(`/api/votes/${voteId}/respond`, {
        method: 'POST',
        body: JSON.stringify({
          playerId,
          decision,
        }),
      });
      setState(payload);
      setSlotWarning('');
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    const boardId = state.board?.id;
    if (!boardId || !playerId) {
      setLocalCardPositions({});
      return;
    }

    const key = `byob-card-positions:${playerId}:${boardId}`;
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      setLocalCardPositions(parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
      setLocalCardPositions({});
    }
  }, [state.board?.id, playerId]);

  useEffect(() => {
    const boardId = state.board?.id;
    if (!boardId || !playerId) {
      return;
    }

    const key = `byob-card-positions:${playerId}:${boardId}`;
    localStorage.setItem(key, JSON.stringify(localCardPositions));
  }, [localCardPositions, state.board?.id, playerId]);

  useEffect(() => {
    const validIds = new Set((state.cards || []).map((card) => String(card.id)));
    setLocalCardPositions((current) => {
      let changed = false;
      const next = {};

      Object.entries(current).forEach(([id, pos]) => {
        if (validIds.has(String(id))) {
          next[id] = pos;
        } else {
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [state.cards]);

  useEffect(() => {
    const board = state.board;
    const isPaused = Boolean(state.session?.isPaused);
    const prevBoardId = prevBoardIdRef.current;
    const prevPaused = prevPausedRef.current;

    const hasBoardChanged = prevBoardId !== null && board && prevBoardId !== board.id;
    const hasUnpaused = prevPaused === true && isPaused === false;
    const isFirstQuestion = !didShowInitialQuestionRef.current && board;

    if ((isFirstQuestion || hasBoardChanged || hasUnpaused) && board?.question) {
      didShowInitialQuestionRef.current = true;
      setQuestionText(board.question);
      setQuestionVisibleCount(0);
      setQuestionPhase('typing');
    }

    prevBoardIdRef.current = board ? board.id : null;
    prevPausedRef.current = isPaused;
  }, [state.board, state.session?.isPaused]);

  useEffect(() => {
    if (questionPhase !== 'typing' || !questionText) {
      return undefined;
    }

    let index = 0;
    const timer = setInterval(() => {
      index += 1;
      setQuestionVisibleCount(index);

      if (index >= questionText.length) {
        clearInterval(timer);
        setTimeout(() => {
          setQuestionPhase('docking');
          setTimeout(() => setQuestionPhase('docked'), 900);
        }, 1000);
      }
    }, 30);

    return () => clearInterval(timer);
  }, [questionPhase, questionText]);

  useEffect(() => {
    if (state.session?.isPaused) {
      setActiveCardId(null);
    }
  }, [state.session?.isPaused]);

  useEffect(() => {
    setSlotWarning('');
  }, [state.board?.id]);

  if (state.session?.isPaused) {
    return (
      <main className="app-shell waiting-shell">
        {error ? <p className="error-banner">{error}</p> : null}
        <section className="waiting-panel">
          <h2>{state.session.message || 'Waiting for others'}</h2>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      {error ? <p className="error-banner">{error}</p> : null}
      {questionPhase !== 'hidden' && questionText ? (
        <div className={`question-overlay ${questionPhase}`}>
          <p className="question-text-shell">
            <span className="question-text-base">{questionText}</span>
            <span className="question-text-reveal">{questionText.slice(0, questionVisibleCount)}</span>
          </p>
        </div>
      ) : null}

      <section className={`approvals-section ${slotWarning ? 'warning' : ''}`}>
        {slotWarning ? <p className="approval-warning">{slotWarning}</p> : null}
        <div className="approval-slots">
          {Array.from({ length: state.board?.selectionLimit || 0 }).map((_, i) => {
            const selectedCards = state.cards?.filter((c) => c.selected) || [];
            const card = selectedCards[i];
            return (
              <div
                key={i}
                className={`approval-slot ${card ? 'filled' : 'empty'} ${slotWarning && card ? 'warning' : ''}`.trim()}
                title={card?.title || ''}
                onClick={() => card && setActiveCardId(card.id)}
              >
                {card ? card.title : ''}
              </div>
            );
          })}
        </div>
      </section>

      <section className="board-stage">
        <FloatingCards
          playerId={playerId}
          cards={state.cards}
          tooltipTerms={state.tooltipTerms || []}
          activeCardId={activeCardId}
          setActiveCardId={setActiveCardId}
          onSuggestVote={suggestVote}
          onRespondVote={respondVote}
          cardPositions={localCardPositions}
          setCardPositions={setLocalCardPositions}
        />
      </section>
    </main>
  );
}

function AdminView() {
  const [state, setState] = useState({ board: null, cards: [] });
  const [error, setError] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [boards, setBoards] = useState([]);
  const [openVotes, setOpenVotes] = useState([]);
  const [activePlayers, setActivePlayers] = useState({ count: 0, players: [], activeWindowMinutes: 0 });
  const [sessionState, setSessionState] = useState({ isPaused: false, message: 'Waiting for others' });
  const [pauseMessage, setPauseMessage] = useState('Waiting for others');
  const [managedCards, setManagedCards] = useState([]);
  const [editingCardId, setEditingCardId] = useState(null);
  const [editCard, setEditCard] = useState({ title: '', summary: '', content: '' });
  const [deleteBoardId, setDeleteBoardId] = useState('');
  const [tooltipTerms, setTooltipTerms] = useState([]);
  const [hasLoadedTooltipTerms, setHasLoadedTooltipTerms] = useState(false);
  const [isTooltipEditorOpen, setIsTooltipEditorOpen] = useState(false);
  const [tooltipDraft, setTooltipDraft] = useState([]);
  const [isTooltipLoading, setIsTooltipLoading] = useState(false);
  const [isTooltipSaving, setIsTooltipSaving] = useState(false);

  const [newBoard, setNewBoard] = useState({
    title: '',
    question: '',
    selectionLimit: 3,
  });
  const [newCard, setNewCard] = useState({
    boardId: '',
    title: '',
    summary: '',
    content: '',
  });

  function goToPlayer() {
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  useEffect(() => {
    checkAdminStatus();
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      return undefined;
    }

    const poll = setInterval(() => {
      refreshAdminData();
    }, 3000);

    return () => clearInterval(poll);
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }
    ensureTooltipTermsLoaded().catch(() => {});
  }, [isAdmin]);

  function sanitizeTooltipTerms(terms) {
    const cleaned = [];
    const seen = new Set();

    (terms || []).forEach((entry) => {
      const term = String(entry?.term || '').trim();
      const definition = String(entry?.definition || '').trim();
      if (!term || !definition) {
        return;
      }

      const key = term.toLowerCase();
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      cleaned.push({ term, definition });
    });

    return cleaned;
  }

  async function ensureTooltipTermsLoaded() {
    if (hasLoadedTooltipTerms) {
      return tooltipTerms;
    }

    const payload = await api('/api/admin/tooltips');
    const terms = sanitizeTooltipTerms(payload.terms || []);
    setTooltipTerms(terms);
    setHasLoadedTooltipTerms(true);
    return terms;
  }

  async function openTooltipEditor() {
    setIsTooltipEditorOpen(true);
    setIsTooltipLoading(true);

    try {
      const terms = await ensureTooltipTermsLoaded();
      setTooltipDraft(terms.length > 0 ? terms : [{ term: '', definition: '' }]);
      setError('');
    } catch (err) {
      setError(err.message);
      setTooltipDraft([{ term: '', definition: '' }]);
    } finally {
      setIsTooltipLoading(false);
    }
  }

  async function saveTooltipTerms() {
    const terms = sanitizeTooltipTerms(tooltipDraft);
    setIsTooltipSaving(true);
    try {
      const payload = await api('/api/admin/tooltips', {
        method: 'PUT',
        body: JSON.stringify({ terms }),
      });
      const normalized = sanitizeTooltipTerms(payload.terms || []);
      setTooltipTerms(normalized);
      setHasLoadedTooltipTerms(true);
      setTooltipDraft(normalized.length > 0 ? normalized : [{ term: '', definition: '' }]);
      setError('');
      await api('/api/game-state').then(setState).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setIsTooltipSaving(false);
    }
  }

  async function checkAdminStatus() {
    try {
      const payload = await api('/api/admin/status');
      setIsAdmin(Boolean(payload.isAdmin));
      if (payload.isAdmin) {
        refreshAdminData();
      }
    } catch {
      setIsAdmin(false);
    }
  }

  async function refreshAdminData() {
    try {
      const [boardsRes, votesRes, activePlayersRes, sessionRes] = await Promise.all([
        api('/api/admin/boards'),
        api('/api/admin/open-votes'),
        api('/api/admin/active-players'),
        api('/api/admin/session-state'),
      ]);

      const activeBoard = boardsRes.boards.find((board) => board.isActive);
      const cardsRes = activeBoard ? await api(`/api/admin/boards/${activeBoard.id}/cards`) : { cards: [] };

      setBoards(boardsRes.boards);
      setOpenVotes(votesRes.votes);
      setManagedCards(cardsRes.cards || []);
      setActivePlayers({
        count: Number(activePlayersRes.count ?? 0),
        players: activePlayersRes.players || [],
        activeWindowMinutes: Number(activePlayersRes.activeWindowMinutes ?? 0),
      });
      setSessionState({
        isPaused: Boolean(sessionRes.isPaused),
        message: sessionRes.message || 'Waiting for others',
      });
      setPauseMessage(sessionRes.message || 'Waiting for others');
      if (boardsRes.boards.length > 0) {
        const hasDeleteTarget = boardsRes.boards.some((board) => String(board.id) === String(deleteBoardId));
        if (!deleteBoardId || !hasDeleteTarget) {
          setDeleteBoardId(String(boardsRes.boards[0].id));
        }
      } else if (deleteBoardId) {
        setDeleteBoardId('');
      }
      if (boardsRes.boards.length > 0) {
        const hasCurrentBoard = boardsRes.boards.some((board) => String(board.id) === String(newCard.boardId));
        if (!newCard.boardId || !hasCurrentBoard) {
          setNewCard((current) => ({ ...current, boardId: String(boardsRes.boards[0].id) }));
        }
      } else if (newCard.boardId) {
        setNewCard((current) => ({ ...current, boardId: '' }));
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitAdminLogin(event) {
    event.preventDefault();
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: adminPassword }),
      });
      setAdminPassword('');
      setIsAdmin(true);
      setError('');
      await refreshAdminData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createBoard(event) {
    event.preventDefault();
    try {
      await api('/api/admin/boards', {
        method: 'POST',
        body: JSON.stringify({
          ...newBoard,
          selectionLimit: Number(newBoard.selectionLimit),
        }),
      });
      setNewBoard({ title: '', question: '', selectionLimit: 3 });
      await refreshAdminData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createCard(event) {
    event.preventDefault();
    try {
      await api('/api/admin/cards', {
        method: 'POST',
        body: JSON.stringify({
          ...newCard,
          boardId: Number(newCard.boardId),
        }),
      });
      setNewCard((current) => ({
        ...current,
        title: '',
        summary: '',
        content: '',
      }));
      await refreshAdminData();
      await api('/api/game-state').then(setState).catch(() => {});
    } catch (err) {
      setError(err.message);
    }
  }

  async function swapBoard(boardId) {
    try {
      const payload = await api('/api/admin/swap-board', {
        method: 'POST',
        body: JSON.stringify({ boardId }),
      });
      setState(payload);
      await refreshAdminData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function terminateVote(voteId) {
    try {
      await api(`/api/admin/votes/${voteId}/terminate`, {
        method: 'POST',
      });
      await refreshAdminData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleSessionPause() {
    try {
      const payload = await api('/api/admin/session-state', {
        method: 'POST',
        body: JSON.stringify({
          isPaused: !sessionState.isPaused,
          message: pauseMessage || 'Waiting for others',
        }),
      });
      setSessionState({
        isPaused: Boolean(payload.isPaused),
        message: payload.message || 'Waiting for others',
      });
      setPauseMessage(payload.message || 'Waiting for others');
      await refreshAdminData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function wipePlayers() {
    try {
      await api('/api/admin/wipe-players', {
        method: 'POST',
      });
      await refreshAdminData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteBoard() {
    if (!deleteBoardId) {
      return;
    }

    const confirmed = window.confirm('Delete this board and all associated cards/votes?');
    if (!confirmed) {
      return;
    }

    try {
      await api(`/api/admin/boards/${deleteBoardId}`, {
        method: 'DELETE',
      });
      await refreshAdminData();
    } catch (err) {
      setError(err.message);
    }
  }

  function beginCardEdit(card) {
    setEditingCardId(card.id);
    setEditCard({
      title: card.title,
      summary: card.summary,
      content: card.content,
    });
  }

  function cancelCardEdit() {
    setEditingCardId(null);
    setEditCard({ title: '', summary: '', content: '' });
  }

  async function saveCardEdit(cardId) {
    try {
      await api(`/api/admin/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify(editCard),
      });
      cancelCardEdit();
      await refreshAdminData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteCard(cardId) {
    const confirmed = window.confirm('Delete this card? This cannot be undone.');
    if (!confirmed) {
      return;
    }

    try {
      await api(`/api/admin/cards/${cardId}`, {
        method: 'DELETE',
      });
      if (editingCardId === cardId) {
        cancelCardEdit();
      }
      await refreshAdminData();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main className="app-shell">
      <header className="main-header">
        <div>
          <p className="kicker">BYOB Dungeon Master Panel</p>
          <h1>Board & Card Administration</h1>
        </div>
        <button onClick={goToPlayer} style={{ marginTop: '0.5rem' }} className="btn-back">Back to Game</button>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      {!isAdmin ? (
        <section className="admin-stage">
          <form className="panel" onSubmit={submitAdminLogin}>
            <h2>Dungeon Master Access</h2>
            <p>Login to create cards, boards, and control active voting boards.</p>
            <label>
              Admin Password
              <input
                type="password"
                value={adminPassword}
                onChange={(event) => setAdminPassword(event.target.value)}
                required
              />
            </label>
            <button type="submit">Login</button>
          </form>
        </section>
      ) : (
        <section className="admin-stage">
          <div className="admin-grid">
            <section className="panel">
              <h2>Create Board</h2>
              <form onSubmit={createBoard}>
                <label>
                  Board Name
                  <input
                    value={newBoard.title}
                    onChange={(event) => setNewBoard((current) => ({ ...current, title: event.target.value }))}
                    required
                  />
                </label>
                <label>
                  Leading Question
                  <textarea
                    value={newBoard.question}
                    onChange={(event) =>
                      setNewBoard((current) => ({ ...current, question: event.target.value }))
                    }
                    rows={3}
                    required
                  />
                </label>
                <label>
                  Number of Selections
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={newBoard.selectionLimit}
                    onChange={(event) =>
                      setNewBoard((current) => ({ ...current, selectionLimit: event.target.value }))
                    }
                    required
                  />
                </label>
                <button type="submit">Create Board</button>
              </form>

              <hr />

              <h3>Swap To Board</h3>
              <div className="board-list">
                {boards.map((board) => (
                  <button
                    type="button"
                    key={board.id}
                    className={board.isActive ? 'board-chip active' : 'board-chip'}
                    onClick={() => swapBoard(board.id)}
                  >
                    {board.title}
                  </button>
                ))}
              </div>

              <h3>Delete Board</h3>
              <label>
                Board To Delete
                <select value={deleteBoardId} onChange={(event) => setDeleteBoardId(event.target.value)}>
                  {boards.map((board) => (
                    <option key={board.id} value={board.id}>
                      {board.title}{board.isActive ? ' (active)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="danger" onClick={deleteBoard} disabled={!deleteBoardId}>
                Delete Selected Board
              </button>

              <hr />

              <h3>Session Controls</h3>
              <label>
                Pause Message
                <input
                  value={pauseMessage}
                  onChange={(event) => setPauseMessage(event.target.value)}
                  placeholder="Waiting for others"
                />
              </label>
              <button
                type="button"
                className={sessionState.isPaused ? 'pause-toggle resume' : 'pause-toggle pause'}
                onClick={toggleSessionPause}
              >
                {sessionState.isPaused ? 'Resume Session' : 'Pause Session'}
              </button>
              <p>
                Status: <strong>{sessionState.isPaused ? 'Paused' : 'Live'}</strong>
              </p>
              <button type="button" onClick={wipePlayers}>
                Wipe Players
              </button>
            </section>

            <section className="panel">
              <h2>Create Card</h2>
              <p>
                Card Management is in this panel below the preview section.
              </p>
              <form onSubmit={createCard}>
                <label>
                  Board
                  <select
                    value={newCard.boardId}
                    onChange={(event) => setNewCard((current) => ({ ...current, boardId: event.target.value }))}
                    required
                  >
                    <option value="" disabled>
                      Select a board
                    </option>
                    {boards.map((board) => (
                      <option key={board.id} value={board.id}>
                        {board.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Card Title
                  <input
                    value={newCard.title}
                    onChange={(event) => setNewCard((current) => ({ ...current, title: event.target.value }))}
                    required
                  />
                </label>
                <label>
                  Summary
                  <input
                    value={newCard.summary}
                    onChange={(event) => setNewCard((current) => ({ ...current, summary: event.target.value }))}
                    required
                  />
                </label>

                <div className="editor-toolbar">
                  <button type="button" onClick={openTooltipEditor}>
                    Edit Tooltip Terms
                  </button>
                </div>

                <details className="format-help">
                  <summary className="kicker">Formatting Codes</summary>
                  <p>
                    Colors: &amp;0 black, &amp;1 dark_blue, &amp;2 dark_green, &amp;3 dark_aqua, &amp;4 dark_red,
                    &amp;5 dark_purple, &amp;6 gold, &amp;7 gray, &amp;8 dark_gray, &amp;9 blue, &amp;a green,
                    &amp;b aqua, &amp;c red, &amp;d light_purple, &amp;e yellow, &amp;f white.
                  </p>
                  <p>
                    Styles: &amp;l bold, &amp;m strikethrough, &amp;n underline, &amp;o italic, &amp;r reset.
                    Escape ampersand with \&amp;.
                  </p>
                  <p>Tooltip terms: wrap a known term in [brackets] to highlight it and show a definition.</p>
                </details>

                <label>
                  Card Content
                  <textarea
                    value={newCard.content}
                    onChange={(event) => setNewCard((current) => ({ ...current, content: event.target.value }))}
                    rows={10}
                    required
                  />
                </label>
                <button type="submit">Create Card</button>
              </form>

              <div className="preview-box">
                <p className="kicker">Preview</p>
                {newCard.content ? (
                  <TooltipRichText
                    content={newCard.content}
                    terms={tooltipTerms}
                    className="formatted-text-surface"
                  />
                ) : (
                  <p>No preview yet. Start typing card content.</p>
                )}
              </div>

              <hr />

              <h3 id="card-management">Card Management (Active Board)</h3>
              {managedCards.length === 0 ? <p>No cards on the active board.</p> : null}
              <div className="managed-card-list">
                {managedCards.map((card) => (
                  <article key={card.id} className="managed-card-row">
                    {editingCardId === card.id ? (
                      <div className="managed-card-editor">
                        <label>
                          Title
                          <input
                            value={editCard.title}
                            onChange={(event) => setEditCard((current) => ({ ...current, title: event.target.value }))}
                          />
                        </label>
                        <label>
                          Summary
                          <input
                            value={editCard.summary}
                            onChange={(event) => setEditCard((current) => ({ ...current, summary: event.target.value }))}
                          />
                        </label>
                        <label>
                          Content
                          <textarea
                            rows={5}
                            value={editCard.content}
                            onChange={(event) => setEditCard((current) => ({ ...current, content: event.target.value }))}
                          />
                        </label>
                        <div className="managed-card-actions">
                          <button type="button" onClick={() => saveCardEdit(card.id)}>
                            Save
                          </button>
                          <button type="button" onClick={cancelCardEdit}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <h4>{card.title}</h4>
                        <p>{card.summary}</p>
                        <p className="managed-card-meta">{card.selected ? 'Selected' : 'Not selected'}</p>
                        <div className="managed-card-actions">
                          <button type="button" onClick={() => beginCardEdit(card)}>
                            Edit
                          </button>
                          <button type="button" className="danger" onClick={() => deleteCard(card.id)}>
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </article>
                ))}
              </div>
            </section>

            <section className="panel votes-panel">
              <h2>Selected Cards</h2>
              <div className="selected-card-menu">
                {(managedCards || []).filter((card) => card.selected).length === 0 ? (
                  <p>No cards have passed selection on the active board.</p>
                ) : (
                  <ul className="selected-card-list">
                    {(managedCards || [])
                      .filter((card) => card.selected)
                      .map((card) => (
                        <li key={card.id}>{card.title}</li>
                      ))}
                  </ul>
                )}
              </div>

              <h2>Active Votes</h2>
              <p>
                Active Players: <strong>{activePlayers.count}</strong>
                {activePlayers.activeWindowMinutes ? ` (last ${activePlayers.activeWindowMinutes} min)` : ''}
              </p>
              <ul className="active-player-list">
                {activePlayers.players.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
              {openVotes.length === 0 ? <p>No open votes.</p> : null}
              {openVotes.map((vote) => (
                <article key={vote.id} className="vote-row">
                  <h3>{vote.cardTitle}</h3>
                  <p>
                    {vote.boardTitle} · {vote.type}
                  </p>
                  <div className="vote-slot-row">
                    {vote.responses.map((response) => (
                      <span key={response.player_id} className={`slot-pill ${response.decision}`}>
                        {response.decision === 'approve' ? 'Y' : 'N'}
                      </span>
                    ))}
                  </div>
                  <button type="button" className="terminate-vote" onClick={() => terminateVote(vote.id)}>
                    Terminate Vote
                  </button>
                </article>
              ))}
            </section>
          </div>
        </section>
      )}

      {isTooltipEditorOpen ? (
        <div className="modal-scrim" onClick={() => setIsTooltipEditorOpen(false)}>
          <section className="tooltip-editor-modal" onClick={(event) => event.stopPropagation()}>
            <header className="tooltip-editor-header">
              <h3>Tooltip Terms</h3>
              <button type="button" onClick={() => setIsTooltipEditorOpen(false)}>
                Close
              </button>
            </header>

            <div className="tooltip-editor-scroll">
              {isTooltipLoading ? <p>Loading terms...</p> : null}
              {!isTooltipLoading
                ? tooltipDraft.map((entry, index) => (
                    <article key={`tooltip-row-${index}`} className="tooltip-editor-row">
                      <label>
                        Term
                        <input
                          value={entry.term}
                          onChange={(event) =>
                            setTooltipDraft((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, term: event.target.value } : item,
                              ),
                            )
                          }
                          placeholder="Arcane"
                        />
                      </label>
                      <label>
                        Definition
                        <textarea
                          rows={3}
                          value={entry.definition}
                          onChange={(event) =>
                            setTooltipDraft((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, definition: event.target.value } : item,
                              ),
                            )
                          }
                          placeholder="May include [other terms] and & formatting codes"
                        />
                      </label>
                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          setTooltipDraft((current) =>
                            current.length === 1
                              ? [{ term: '', definition: '' }]
                              : current.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                      >
                        Remove
                      </button>
                    </article>
                  ))
                : null}
            </div>

            <div className="tooltip-editor-actions">
              <button
                type="button"
                onClick={() => setTooltipDraft((current) => [...current, { term: '', definition: '' }])}
              >
                Add Term
              </button>
              <button type="button" onClick={saveTooltipTerms} disabled={isTooltipSaving || isTooltipLoading}>
                {isTooltipSaving ? 'Saving...' : 'Save Terms'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function FloatingCards({
  playerId,
  cards,
  tooltipTerms,
  activeCardId,
  setActiveCardId,
  onSuggestVote,
  onRespondVote,
  cardPositions,
  setCardPositions,
}) {
  const [dragState, setDragState] = useState(null);

  const topZ = useMemo(
    () =>
      cards.reduce((max, card) => {
        const localPosition = cardPositions[String(card.id)];
        return Math.max(max, localPosition?.zIndex || card.zIndex || 1);
      }, 1),
    [cards, cardPositions],
  );

  useEffect(() => {
    if (!dragState) {
      return undefined;
    }

    function onMove(event) {
      setDragState((current) => {
        if (!current) {
          return null;
        }

        const rect = document.querySelector('.cards-plane')?.getBoundingClientRect();
        const nextX = event.clientX - (rect?.left || 0) - current.offsetX;
        const nextY = event.clientY - (rect?.top || 0) - current.offsetY;
        const card = document.querySelector(`[data-card-id="${current.cardId}"]`);
        if (card) {
          card.style.left = `${Math.max(0, nextX)}px`;
          card.style.top = `${Math.max(0, nextY)}px`;
        }

        return {
          ...current,
          x: Math.max(0, nextX),
          y: Math.max(0, nextY),
        };
      });
    }

    function onUp() {
      if (!dragState) {
        return;
      }

      const moved = Math.abs(dragState.x - dragState.startX) > 5 || Math.abs(dragState.y - dragState.startY) > 5;
      if (!moved) {
        setActiveCardId((current) => (current === dragState.cardId ? null : dragState.cardId));
      } else {
        setCardPositions((current) => ({
          ...current,
          [String(dragState.cardId)]: {
            x: dragState.x,
            y: dragState.y,
            zIndex: topZ + 1,
          },
        }));
      }

      setDragState(null);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragState, setActiveCardId, topZ]);

  return (
    <div className="cards-plane">
      {cards.map((card) => {
        const isActive = card.id === activeCardId;
        const voteTone = card.openVote ? 'card-vote' : card.selected ? 'card-selected' : '';
        const myDecision = card.openVote?.responses.find((entry) => entry.player_id === playerId)?.decision;
        const localPosition = cardPositions[String(card.id)];
        const displayX = localPosition?.x ?? card.x;
        const displayY = localPosition?.y ?? card.y;
        const displayZ = localPosition?.zIndex ?? card.zIndex;

        return (
          <article
            key={card.id}
            data-card-id={card.id}
            className={`floating-card ${isActive ? 'active' : ''} ${voteTone}`.trim()}
            style={{
              left: displayX,
              top: displayY,
              zIndex: isActive ? 999 : displayZ,
            }}
            onPointerDown={(event) => {
              if (event.target.closest('button, a, input, textarea, select')) {
                return;
              }

              const rect = event.currentTarget.getBoundingClientRect();
              setDragState({
                cardId: card.id,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top,
                startX: displayX,
                startY: displayY,
                x: displayX,
                y: displayY,
              });
            }}
          >
            {card.openVote ? (
              <p className={`vote-intent ${card.openVote.type}`}>
                {card.openVote.type === 'addition' ? 'Up for addition' : 'Up for removal'}
              </p>
            ) : null}
            <h3>{card.title}</h3>
            <p>{card.summary}</p>

            {isActive ? (
              <div className="expanded-content">
                {card.openVote ? (
                  <div className="vote-strip">
                    {card.openVote.responses.map((entry) => (
                      <span key={entry.player_id} className={`slot-pill ${entry.decision}`}>
                        {entry.decision === 'approve' ? 'Y' : 'N'}
                      </span>
                    ))}
                  </div>
                ) : null}

                <TooltipRichText content={card.content} terms={tooltipTerms} className="formatted-text-surface" />

                {!card.openVote && !card.selected ? (
                  <button
                    className="suggest-btn addition"
                    type="button"
                    onClick={() => onSuggestVote(card, 'addition')}
                  >
                    Suggest Addition
                  </button>
                ) : null}

                {!card.openVote && card.selected ? (
                  <button
                    className="suggest-btn removal"
                    type="button"
                    onClick={() => onSuggestVote(card, 'removal')}
                  >
                    Suggest Removal
                  </button>
                ) : null}

                {card.openVote ? (
                  <div className="decision-row">
                    <button
                      type="button"
                      className={`decision approve ${myDecision === 'approve' ? 'is-selected' : ''}`}
                      onClick={() => onRespondVote(card.openVote.id, 'approve')}
                    >
                      {myDecision === 'approve' ? 'Approved' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      className={`decision deny ${myDecision === 'deny' ? 'is-selected' : ''}`}
                      onClick={() => onRespondVote(card.openVote.id, 'deny')}
                    >
                      {myDecision === 'deny' ? 'Denied' : 'Deny'}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function App() {
  const [bootFinished, setBootFinished] = useState(false);
  const [playerId, setPlayerId] = useState('');
  const [route, setRoute] = useState(() => window.location.pathname || '/');

  useEffect(() => {
    const stored = localStorage.getItem('byob-player-id');
    if (stored) {
      setPlayerId(stored);
    } else {
      const newId = generateUUID();
      setPlayerId(newId);
      localStorage.setItem('byob-player-id', newId);
    }
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(window.location.pathname);
    };

    window.addEventListener('popstate', handlePopState);
    setRoute(window.location.pathname);

    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  if (route === '/admin') {
    return <AdminView />;
  }

  if (!bootFinished) {
    return <Boot onFinish={() => setBootFinished(true)} />;
  }

  if (route === '/' && playerId) {
    return <PlayerView playerId={playerId} />;
  }

  return null;
}

export default App;
