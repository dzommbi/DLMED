(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const app = $('#testApp');
  const loading = $('#authLoading');
  const catalogView = $('#catalogView');
  const runnerView = $('#runnerView');
  const resultsView = $('#resultsView');
  const questionCard = $('#questionCard');
  const testBank = Array.isArray(window.DLMED_TEST_BANK) ? window.DLMED_TEST_BANK : [];
  const attemptPrefix = 'dlmed-test-attempt-v1:';
  let tests = [];
  let activeTest = null;
  let answers = Object.create(null);
  let questionIndex = 0;
  let startedAt = 0;
  let clockId = 0;
  let bootPromise = null;
  let booted = false;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  function letterFor(index) {
    return String.fromCharCode(65 + index);
  }

  function parseAnswerToken(value) {
    if (Number.isInteger(value)) return value;
    if (typeof value !== 'string') return -1;
    const token = value.trim().toUpperCase();
    if (/^[A-Z]$/.test(token)) return token.charCodeAt(0) - 65;
    if (/^\d+$/.test(token)) {
      const number = Number(token);
      return number > 0 ? number - 1 : 0;
    }
    return -1;
  }

  function correctIndexes(question) {
    const raw = question.correctAnswer ?? question.answer ?? question.correct;
    const values = Array.isArray(raw) ? raw : [raw];
    return [...new Set(values.map(parseAnswerToken).filter(index => index >= 0 && index < question.options.length))].sort((a, b) => a - b);
  }

  function normalizeTest(raw, position) {
    const id = String(raw?.id || `test-${String(position + 1).padStart(2, '0')}`);
    const questions = (Array.isArray(raw?.questions) ? raw.questions : []).map((question, index) => {
      const options = Array.isArray(question?.options)
        ? question.options.map(option => typeof option === 'object' && option !== null ? String(option.text ?? option.label ?? '') : String(option ?? ''))
        : [];
      const normalized = {
        id: String(question?.id || `${id}-q${index + 1}`),
        text: String(question?.text ?? question?.question ?? ''),
        options,
        answer: question?.correctAnswer ?? question?.answer ?? question?.correct,
        explanation: String(question?.explanation ?? question?.correction ?? '')
      };
      normalized.correctIndexes = correctIndexes(normalized);
      return normalized;
    });
    const validQuestions = questions.length > 0 && questions.every(question =>
      question.text.trim() && question.options.length >= 2
      && question.options.every(option => option.trim())
      && question.correctIndexes.length > 0
    );
    return {
      id,
      title: String(raw?.title || `Test ${String(position + 1).padStart(2, '0')}`),
      subject: String(raw?.subject || 'Test médical'),
      description: String(raw?.description || ''),
      questions,
      valid: validQuestions
    };
  }

  function savedAttempt(test) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(attemptPrefix + test.id) || 'null');
      if (!saved || saved.testId !== test.id || !['in-progress', 'finished'].includes(saved.phase)) return null;
      const restored = Object.create(null);
      const source = saved.answers && typeof saved.answers === 'object' ? saved.answers : {};
      test.questions.forEach(question => {
        const selected = Array.isArray(source[question.id])
          ? source[question.id].filter(index => Number.isInteger(index) && index >= 0 && index < question.options.length)
          : [];
        if (selected.length) restored[question.id] = [...new Set(selected)].sort((a, b) => a - b);
      });
      return {
        phase: saved.phase,
        answers: restored,
        questionIndex: Math.min(Math.max(Number(saved.questionIndex) || 0, 0), test.questions.length - 1),
        startedAt: Number(saved.startedAt) || Date.now(),
        finishedAt: Number(saved.finishedAt) || 0
      };
    } catch (_) {
      return null;
    }
  }

  function storeAttempt(phase = 'in-progress', finishedAt = 0) {
    if (!activeTest) return;
    try {
      sessionStorage.setItem(attemptPrefix + activeTest.id, JSON.stringify({
        testId: activeTest.id,
        phase,
        answers,
        questionIndex,
        startedAt,
        finishedAt
      }));
    } catch (_) {}
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const remaining = safe % 60;
    return hours
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
  }

  function elapsedSeconds() {
    return startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  }

  function updateClock() {
    const time = formatTime(elapsedSeconds());
    $('#runnerTimer').textContent = `⏱ ${time}`;
  }

  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => node.classList.remove('show'), 2600);
  }

  function setUrl(testId = '') {
    const url = new URL(window.location.href);
    if (testId) url.searchParams.set('test', testId);
    else url.searchParams.delete('test');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  function renderCatalog() {
    const catalog = $('#testCatalog');
    const empty = $('#testEmpty');
    const validTests = tests.filter(test => test.valid);
    const invalidTests = tests.filter(test => !test.valid);
    $('#testCount').textContent = `${validTests.length} ${validTests.length === 1 ? 'test disponible' : 'tests disponibles'}`;
    empty.hidden = validTests.length > 0;
    catalog.innerHTML = validTests.map((test, index) => {
      const saved = savedAttempt(test);
      const action = saved?.phase === 'finished' ? 'Voir ma correction' : saved?.phase === 'in-progress' ? 'Reprendre le test' : 'Commencer';
      const number = String(index + 1).padStart(2, '0');
      const description = test.description || test.subject;
      return `<article class="test-card"><div class="test-card-top"><span class="test-number">${number}</span><span class="test-count">${test.questions.length} questions</span></div><h3>${escapeHtml(test.title)}</h3><p>${escapeHtml(description)}</p><button class="btn primary" type="button" data-start-test="${escapeHtml(test.id)}">${action} →</button></article>`;
    }).join('');
    if (invalidTests.length) {
      const note = document.createElement('p');
      note.className = 'fine-print';
      note.textContent = 'Un test est masqué car son énoncé, ses choix ou son corrigé sont incomplets.';
      catalog.append(note);
    }
    catalog.querySelectorAll('[data-start-test]').forEach(button => button.addEventListener('click', () => {
      const test = validTests.find(item => item.id === button.dataset.startTest);
      if (test) void startTest(test);
    }));
  }

  function showView(view) {
    catalogView.hidden = view !== 'catalog';
    runnerView.hidden = view !== 'runner';
    resultsView.hidden = view !== 'results';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function startTest(test, fresh = false) {
    if (!window.DLMED_AUTH?.isAuthorized?.() || !await window.DLMED_AUTH.ensureActiveSession()) return;
    window.clearInterval(clockId);
    activeTest = test;
    if (fresh) {
      try { sessionStorage.removeItem(attemptPrefix + test.id); } catch (_) {}
    }
    const saved = fresh ? null : savedAttempt(test);
    answers = saved?.answers || Object.create(null);
    questionIndex = saved?.questionIndex || 0;
    startedAt = saved?.startedAt || Date.now();
    setUrl(test.id);
    if (saved?.phase === 'finished') {
      renderResults(saved.finishedAt);
      return;
    }
    $('#runnerTestNumber').textContent = `TEST ${String(tests.filter(item => item.valid).indexOf(test) + 1).padStart(2, '0')}`;
    $('#runnerTitle').textContent = test.title;
    $('#runnerCopy').textContent = `${test.subject} · ${test.questions.length} questions · correction à la fin`;
    $('#unansweredNotice').hidden = true;
    showView('runner');
    renderQuestion();
    updateClock();
    clockId = window.setInterval(updateClock, 1000);
    storeAttempt();
  }

  function renderQuestion() {
    if (!activeTest) return;
    const question = activeTest.questions[questionIndex];
    if (!question) return;
    const selected = answers[question.id] || [];
    const multiple = question.correctIndexes.length > 1;
    const answeredCount = activeTest.questions.filter(item => (answers[item.id] || []).length > 0).length;
    const progress = Math.round((questionIndex + 1) / activeTest.questions.length * 100);
    $('#progressFill').style.width = `${progress}%`;
    $('.progress-track').setAttribute('aria-valuenow', String(progress));
    questionCard.innerHTML = `
      <div class="question-top"><span>${escapeHtml(activeTest.subject)}</span><span>Question ${questionIndex + 1} / ${activeTest.questions.length} · ${answeredCount} répondue(s)</span></div>
      <h2 class="question-text">${escapeHtml(question.text)}</h2>
      <div class="answer-list" role="group" aria-label="${multiple ? 'Plusieurs réponses possibles' : 'Choisis une réponse'}">
        ${question.options.map((option, index) => `<button class="answer-option${selected.includes(index) ? ' selected' : ''}" type="button" data-option="${index}" aria-pressed="${selected.includes(index)}"><span class="answer-letter">${letterFor(index)}</span><span>${escapeHtml(option)}</span></button>`).join('')}
      </div>
      <div class="question-actions"><span class="question-hint">${multiple ? 'Plusieurs réponses possibles.' : 'Une seule réponse.'} Le corrigé reste masqué jusqu’à la fin.</span><div class="action-group"><button class="btn" id="questionPrevious" type="button" ${questionIndex === 0 ? 'disabled' : ''}>← Précédente</button><button class="btn primary" id="questionNext" type="button">${questionIndex === activeTest.questions.length - 1 ? 'Terminer et corriger ✓' : 'Suivante →'}</button></div></div>`;
    questionCard.querySelectorAll('[data-option]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.option);
      const current = answers[question.id] || [];
      if (multiple) {
        answers[question.id] = current.includes(index) ? current.filter(value => value !== index) : [...current, index].sort((a, b) => a - b);
      } else {
        answers[question.id] = [index];
      }
      $('#unansweredNotice').hidden = true;
      storeAttempt();
      renderQuestion();
    }));
    $('#questionPrevious').addEventListener('click', () => moveQuestion(-1));
    $('#questionNext').addEventListener('click', () => {
      if (questionIndex < activeTest.questions.length - 1) moveQuestion(1);
      else void finishTest();
    });
    $('#questionNav').innerHTML = activeTest.questions.map((item, index) => {
      const answered = (answers[item.id] || []).length > 0;
      return `<button type="button" class="${answered ? 'answered' : ''}${index === questionIndex ? ' current' : ''}" data-question-index="${index}" aria-label="Question ${index + 1}${answered ? ', répondue' : ', sans réponse'}" aria-current="${index === questionIndex ? 'step' : 'false'}">${index + 1}</button>`;
    }).join('');
    $('#questionNav').querySelectorAll('[data-question-index]').forEach(button => button.addEventListener('click', () => {
      questionIndex = Number(button.dataset.questionIndex);
      $('#unansweredNotice').hidden = true;
      storeAttempt();
      renderQuestion();
    }));
  }

  function moveQuestion(amount) {
    if (!activeTest) return;
    questionIndex = Math.min(activeTest.questions.length - 1, Math.max(0, questionIndex + amount));
    $('#unansweredNotice').hidden = true;
    storeAttempt();
    renderQuestion();
  }

  function sameAnswers(selected, correct) {
    const a = [...selected].sort((x, y) => x - y);
    const b = [...correct].sort((x, y) => x - y);
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  async function finishTest() {
    if (!activeTest || !window.DLMED_AUTH?.isAuthorized?.() || !await window.DLMED_AUTH.ensureActiveSession()) return;
    const unanswered = activeTest.questions.findIndex(question => !(answers[question.id] || []).length);
    if (unanswered >= 0) {
      questionIndex = unanswered;
      const notice = $('#unansweredNotice');
      notice.textContent = `Il reste des questions sans réponse. Réponds à la question ${unanswered + 1} pour remettre le test complet.`;
      notice.hidden = false;
      storeAttempt();
      renderQuestion();
      notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    window.clearInterval(clockId);
    storeAttempt('finished', Date.now());
    renderResults(Date.now());
  }

  function renderResults(finishedAt = Date.now()) {
    if (!activeTest) return;
    window.clearInterval(clockId);
    const correctCount = activeTest.questions.filter(question => sameAnswers(answers[question.id] || [], question.correctIndexes)).length;
    const percent = Math.round(correctCount / activeTest.questions.length * 100);
    const score = (correctCount / activeTest.questions.length * 20).toFixed(1).replace('.', ',');
    const duration = formatTime(Math.max(0, Math.floor(((finishedAt || Date.now()) - startedAt) / 1000)));
    const review = activeTest.questions.map((question, index) => {
      const selected = answers[question.id] || [];
      const correct = sameAnswers(selected, question.correctIndexes);
      const selectedLetters = selected.length ? selected.map(letterFor).join(', ') : 'Aucune réponse';
      const correctLetters = question.correctIndexes.map(letterFor).join(', ');
      const options = question.options.map((option, optionIndex) => {
        const isKey = question.correctIndexes.includes(optionIndex);
        const isWrongPick = selected.includes(optionIndex) && !isKey;
        const classes = `${isKey ? ' is-answer-correct' : ''}${isWrongPick ? ' is-answer-wrong' : ''}`;
        const marker = isKey ? ' · Réponse correcte' : isWrongPick ? ' · Ton choix' : '';
        return `<div class="review-option${classes}"><b>${letterFor(optionIndex)}</b><span>${escapeHtml(option)}${marker}</span></div>`;
      }).join('');
      const explanation = question.explanation || 'Aucune explication détaillée n’a été fournie pour cette question.';
      return `<details class="review-item ${correct ? 'is-correct' : 'is-wrong'}"><summary><span class="review-status">${correct ? '✓' : '!'}</span><span class="review-summary"><strong>Question ${index + 1} · ${escapeHtml(question.text)}</strong><small>Ta réponse : ${escapeHtml(selectedLetters)} · Corrigé : ${escapeHtml(correctLetters)}</small></span><span class="review-result-label">${correct ? 'Correcte' : 'À revoir'}</span></summary><div class="review-detail"><p class="review-question">${escapeHtml(question.text)}</p><div class="review-options">${options}</div><div class="review-explanation"><strong>Correction</strong><br>${escapeHtml(explanation)}</div><button class="btn review-ai" type="button" data-ai-review="${index}">✨ Vérifier avec ChatGPT</button></div></details>`;
    }).join('');
    resultsView.innerHTML = `
      <section class="result-hero"><div><span class="test-pill">TEST TERMINÉ</span><h1>Ta copie est corrigée</h1><p>${correctCount} bonne(s) réponse(s) sur ${activeTest.questions.length}. Ouvre une question pour voir le corrigé et comprendre tes erreurs.</p></div><div class="result-score" style="--score:${percent}"><div class="result-score-content"><strong>${score}/20</strong><span>NOTE</span></div></div></section>
      <div class="result-stats"><span class="result-stat"><strong>${percent}%</strong> de réussite</span><span class="result-stat"><strong>${activeTest.questions.length - correctCount}</strong> à revoir</span><span class="result-stat"><strong>${duration}</strong> de durée</span></div>
      <div class="result-actions"><button class="btn" id="otherTests" type="button">← Autres tests</button><button class="btn primary" id="retakeTest" type="button">↻ Refaire ce test</button></div>
      <h2 class="review-title">Correction détaillée</h2><div class="review-list">${review}</div>
      <p class="fine-print">La note est calculée à partir du corrigé officiel joint au test. ChatGPT peut donner un second avis pédagogique ; son avis ne modifie pas ta note.</p>`;
    showView('results');
    $('#otherTests').addEventListener('click', backToCatalog);
    $('#retakeTest').addEventListener('click', () => void startTest(activeTest, true));
    resultsView.querySelectorAll('[data-ai-review]').forEach(button => button.addEventListener('click', () => void askChatGPT(Number(button.dataset.aiReview), button)));
  }

  async function askChatGPT(index, button) {
    const question = activeTest?.questions[index];
    if (!question) return;
    const opened = window.open('about:blank', '_blank');
    if (!opened) {
      toast('Autorise les fenêtres surgissantes pour ouvrir ChatGPT.');
      return;
    }
    opened.opener = null;
    if (!window.DLMED_AUTH?.isAuthorized?.() || !await window.DLMED_AUTH.ensureActiveSession()) {
      opened.close();
      return;
    }
    const prompt = [
      'Vérifie indépendamment cette correction de QCM médical à des fins pédagogiques.',
      `Question : ${question.text}`,
      `Propositions : ${question.options.map((option, optionIndex) => `${letterFor(optionIndex)}. ${option}`).join(' | ')}`,
      `Corrigé officiel fourni : ${question.correctIndexes.map(letterFor).join(', ')}`,
      `Choix de l’étudiant : ${(answers[question.id] || []).map(letterFor).join(', ') || 'aucun'}`,
      `Explication fournie : ${question.explanation || 'aucune'}`,
      'Dis si le corrigé semble correct, explique brièvement pourquoi et indique clairement toute incertitude. N’invente pas de référence.'
    ].join('\n');
    opened.location.href = `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`;
    button.textContent = 'ChatGPT est ouvert';
  }

  function backToCatalog() {
    window.clearInterval(clockId);
    activeTest = null;
    setUrl();
    showView('catalog');
    renderCatalog();
  }

  $('#leaveTest').addEventListener('click', backToCatalog);

  const savedTheme = document.documentElement.dataset.theme === 'night' ? 'night' : 'day';
  document.querySelectorAll('[data-theme-value]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeValue === savedTheme)));
  document.querySelectorAll('[data-theme-value]').forEach(button => button.addEventListener('click', () => {
    const theme = button.dataset.themeValue === 'night' ? 'night' : 'day';
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-theme-value]').forEach(choice => choice.setAttribute('aria-pressed', String(choice.dataset.themeValue === theme)));
    try { localStorage.setItem('dlmed-theme', theme); } catch (_) {}
  }));

  async function boot() {
    if (booted || bootPromise) return bootPromise;
    bootPromise = (async () => {
      try {
        await (window.DLMED_AUTH?.authReady || Promise.resolve());
        if (!window.DLMED_AUTH?.isAuthorized?.()) { loading.hidden = true; return; }
        if (!await window.DLMED_AUTH.ensureActiveSession()) { loading.hidden = true; return; }
        tests = testBank.map(normalizeTest);
        loading.hidden = true;
        app.hidden = false;
        booted = true;
        renderCatalog();
        const requestedId = new URL(window.location.href).searchParams.get('test');
        const requestedTest = tests.find(test => test.id === requestedId && test.valid);
        if (requestedTest) {
          const saved = savedAttempt(requestedTest);
          if (saved) void startTest(requestedTest);
        }
      } catch (_) {
        loading.hidden = true;
        app.hidden = false;
        $('#testCount').textContent = 'Impossible de charger les tests.';
        $('#testEmpty').hidden = false;
        $('#testEmpty').querySelector('h2').textContent = 'Connexion au service impossible';
        $('#testEmpty').querySelector('p').textContent = 'Vérifie ta connexion puis recharge la page.';
      } finally {
        bootPromise = null;
      }
    })();
    return bootPromise;
  }

  window.addEventListener('dlmed:auth-authorized', () => void boot());
  void boot();
})();