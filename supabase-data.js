// DLMED data layer - v120
(() => {
  const client = window.DLMED_SUPABASE;
  const ORDER_KEY = 'dlmed-supabase-option-order-v1';
  const LETTERS = ['A', 'B', 'C', 'D', 'E'];

  async function requireActiveSession() {
    if (!window.DLMED_AUTH?.ensureActiveSession) throw new Error('Authentification requise.');
    if (!await window.DLMED_AUTH.ensureActiveSession()) throw new Error('Session inactive. Reconnecte-toi pour continuer.');
  }

  function readOrders() {
    try { return JSON.parse(localStorage.getItem(ORDER_KEY) || '{}') || {}; } catch (_) { return {}; }
  }

  function shuffledOrder(questionId, savedOrders) {
    const stored = savedOrders[String(questionId)];
    if (Array.isArray(stored) && stored.length === 5 && new Set(stored).size === 5 && stored.every(n => Number.isInteger(n) && n >= 0 && n < 5)) return stored;
    const order = [0, 1, 2, 3, 4];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    savedOrders[String(questionId)] = order;
    return order;
  }

  function parseOptions(raw) {
    let choices;
    let mode = 'single';
    if (Array.isArray(raw)) {
      choices = raw;
    } else if (raw && typeof raw === 'object') {
      mode = raw.mode === 'multiple' || raw.multiple === true ? 'multiple' : 'single';
      choices = raw.choices && typeof raw.choices === 'object' ? LETTERS.map(letter => raw.choices[letter]) : LETTERS.map(letter => raw[letter]);
    }
    if (!Array.isArray(choices) || choices.length !== 5 || choices.some(choice => typeof choice !== 'string')) {
      throw new Error('Une question doit contenir exactement cinq choix A–E.');
    }
    return { choices, mode };
  }

  function normalize(data) {
    const subjects = Array.isArray(data.subjects) ? data.subjects : [];
    const lessons = Array.isArray(data.lessons) ? data.lessons : [];
    const subjectById = new Map(subjects.map(subject => [String(subject.id), subject]));
    const lessonById = new Map(lessons.map(lesson => [String(lesson.id), lesson]));
    const counts = new Map();
    const savedOrders = readOrders();
    const questions = (Array.isArray(data.questions) ? data.questions : []).map(row => {
      const lesson = lessonById.get(String(row.lesson_id));
      const subject = subjectById.get(String(row.subject_id)) || (lesson && subjectById.get(String(lesson.subject_id)));
      if (!lesson) return null;
      const parsed = parseOptions(row.options);
      const order = shuffledOrder(row.id, savedOrders);
      counts.set(String(row.lesson_id), (counts.get(String(row.lesson_id)) || 0) + 1);
      return {
        id: Number(row.id),
        lessonId: Number(row.lesson_id),
        subjectId: Number(row.subject_id),
        subjectName: subject?.name || 'Matière',
        module: lesson.title || 'Cours',
        text: row.question,
        options: order.map(index => parsed.choices[index]),
        optionMap: order.map(index => LETTERS[index]),
        multiple: parsed.mode === 'multiple',
        explanation: '',
        answer: null
      };
    }).filter(Boolean);
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(savedOrders)); } catch (_) {}
    const catalog = subjects.map(subject => ({
      ...subject,
      lessons: lessons.filter(lesson => String(lesson.subject_id) === String(subject.id)).map(lesson => ({
        ...lesson,
        questionCount: counts.get(String(lesson.id)) || 0
      }))
    }));
    return { subjects, lessons, catalog, questions, cached: false };
  }

  async function fetchAllQuestions() {
    const rows = [];
    const pageSize = 500;
    for (let start = 0; ; start += pageSize) {
      const { data, error } = await client.from('questions')
        .select('id,subject_id,lesson_id,question,options')
        .order('id', { ascending: true })
        .range(start, start + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  }

  async function load() {
    if (!client) throw new Error(window.DLMED_SUPABASE_ERROR || 'Client Supabase indisponible.');
    await requireActiveSession();
    const [subjectResult, lessonResult, questions] = await Promise.all([
      client.from('subject').select('id,name,description,icon,sort_order').order('sort_order').order('id'),
      client.from('lessons').select('id,subject_id,title,description,sort_order').order('sort_order').order('id'),
      fetchAllQuestions()
    ]);
    if (subjectResult.error) throw subjectResult.error;
    if (lessonResult.error) throw lessonResult.error;
    // Do not publish a catalogue if the single-device session expired while the
    // parallel Supabase reads were in flight.
    await requireActiveSession();
    return normalize({ subjects: subjectResult.data || [], lessons: lessonResult.data || [], questions });
  }

  async function grade(questionId, selectedLetters) {
    if (!client) throw new Error(window.DLMED_SUPABASE_ERROR || 'Client Supabase indisponible.');
    // Fast path: one network round trip. grade_qcm_question already enforces the
    // active single-device session server-side, and a heartbeat also runs every 12 s,
    // so no separate heartbeat call is needed before grading.
    if (!window.DLMED_AUTH?.isAuthorized?.()) throw new Error('Authentification requise.');
    const { data, error } = await client.rpc('grade_qcm_question', {
      p_question_id: Number(questionId),
      p_selected_options: selectedLetters
    });
    if (error) {
      // Slow path, only on failure: run the full session check so a revoked session
      // is signed out with the proper message instead of a generic error.
      await requireActiveSession();
      throw error;
    }
    if (!data || typeof data.correct !== 'boolean' || !Array.isArray(data.correct_options)) {
      throw new Error('Réponse de correction invalide. Appliquez la migration de correction Supabase.');
    }
    return data;
  }

  window.DLMED_DATA = Object.freeze({ load, grade });
})();