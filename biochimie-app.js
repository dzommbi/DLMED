(() => {
  const modal = document.getElementById('bioQuizModal');
  const content = document.getElementById('bioQuizContent');
  const toggle = document.getElementById('biochimieToggle');
  const lessonsWrap = document.getElementById('biochimieLessons');
  const lessonKeys = ['homme-sain', 'analyse-biochimique', 'marqueurs-cardiaques'];
  const allLessons = window.DLMED_BIOCHIMIE || {};
  const lessons = lessonKeys.map(key => allLessons[key]).filter(Boolean);
  const letters = ['A', 'B', 'C', 'D', 'E'];
  let currentLesson = null;
  let quizQuestions = [];
  let quizAnswers = [];
  let questionIndex = 0;
  let pendingChoice = null;

  if (!modal || !content || !toggle || !lessonsWrap) return;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  function shuffle(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function openQuiz(lessonKey) {
    currentLesson = lessons.find(lesson => lesson.key === lessonKey);
    if (!currentLesson || !Array.isArray(currentLesson.questions)) return;
    quizQuestions = shuffle(currentLesson.questions.map(question => {
      const options = shuffle(question.options.map((text, index) => ({ text, correct: index === question.answer })));
      return { ...question, options: options.map(option => option.text), answer: options.findIndex(option => option.correct) };
    }));
    quizAnswers = new Array(quizQuestions.length).fill(null);
    questionIndex = 0;
    pendingChoice = null;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('bioquiz-open');
    renderQuestion();
    document.getElementById('bioQuizBack')?.focus();
  }

  function closeQuiz() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('bioquiz-open');
    currentLesson = null;
    toggle.focus();
  }

  function renderQuestion() {
    const question = quizQuestions[questionIndex];
    const answer = quizAnswers[questionIndex];
    const progressCount = answer ? questionIndex + 1 : questionIndex;
    const progress = Math.round(progressCount / quizQuestions.length * 100);
    const optionsHtml = question.options.map((option, index) => {
      let state = '';
      if (answer) {
        if (index === question.answer) state = ' is-correct';
        else if (index === answer.selected) state = ' is-wrong';
      } else if (index === pendingChoice) state = ' is-selected';
      return `<button class="bioquiz-option${state}" type="button" data-bio-option="${index}" ${answer ? 'disabled' : ''}><span class="bioquiz-letter">${letters[index]}</span><span>${escapeHtml(option)}</span></button>`;
    }).join('');
    const feedback = answer ? `<div class="bioquiz-feedback ${answer.correct ? 'is-correct' : 'is-wrong'}"><strong>${answer.correct ? '✓ Bonne réponse !' : '✗ Réponse incorrecte'}</strong><div>Réponse correcte : ${letters[question.answer]}. ${escapeHtml(question.options[question.answer])}</div><div class="bioquiz-explanation" dir="auto">${escapeHtml(question.explanation)}</div></div>` : '';

    content.innerHTML = `<div class="bioquiz-top"><button class="bioquiz-back" id="bioQuizBack" type="button">‹ &nbsp;Retour aux cours</button><span class="bioquiz-course-tag">Biochimie · ${escapeHtml(currentLesson.subtitle)}</span></div><h2 class="bioquiz-title" id="bioQuizTitle">${escapeHtml(currentLesson.title)}</h2><div class="bioquiz-meta"><span>Question ${questionIndex + 1} / ${quizQuestions.length}</span><span>${progress}% terminé</span></div><div class="bioquiz-track" role="progressbar" aria-valuemin="0" aria-valuemax="${quizQuestions.length}" aria-valuenow="${progressCount}"><span style="width:${progress}%"></span></div><p class="bioquiz-question">${escapeHtml(question.text)}</p><div class="bioquiz-options">${optionsHtml}</div>${feedback}<div class="bioquiz-footer"><span class="quiet">${answer ? 'Réponse enregistrée pour cette tentative.' : 'Choisis une réponse, puis valide.'}</span>${answer ? `<button class="btn primary" id="bioQuizNext" type="button">${questionIndex === quizQuestions.length - 1 ? 'Afficher le résultat' : 'Question suivante'} →</button>` : '<button class="btn primary" id="bioQuizConfirm" type="button" disabled>Valider ma réponse</button>'}</div>`;

    document.getElementById('bioQuizBack').onclick = closeQuiz;
    content.querySelectorAll('[data-bio-option]').forEach(button => {
      button.onclick = () => {
        if (quizAnswers[questionIndex]) return;
        pendingChoice = Number(button.dataset.bioOption);
        renderQuestion();
        content.querySelector(`[data-bio-option="${pendingChoice}"]`)?.focus();
      };
    });
    const confirm = document.getElementById('bioQuizConfirm');
    if (confirm) {
      confirm.disabled = pendingChoice === null;
      confirm.onclick = () => {
        if (pendingChoice === null || quizAnswers[questionIndex]) return;
        const correct = pendingChoice === question.answer;
        quizAnswers[questionIndex] = { selected: pendingChoice, correct };
        pendingChoice = null;
        if (typeof playFeedback === 'function') playFeedback(correct);
        renderQuestion();
      };
    }
    const next = document.getElementById('bioQuizNext');
    if (next) next.onclick = () => {
      if (!quizAnswers[questionIndex]) return;
      if (questionIndex === quizQuestions.length - 1) renderResult();
      else {
        questionIndex++;
        pendingChoice = null;
        renderQuestion();
      }
    };
  }

  function renderResult() {
    const correctCount = quizAnswers.filter(answer => answer?.correct).length;
    const wrongQuestions = quizAnswers.map((answer, index) => answer && !answer.correct ? { answer, question: quizQuestions[index] } : null).filter(Boolean);
    const percentage = Math.round(correctCount / quizQuestions.length * 100);
    const wrongHtml = wrongQuestions.length ? `<section class="bioquiz-review"><h4>Questions à revoir (${wrongQuestions.length})</h4><div class="bioquiz-review-list">${wrongQuestions.map(({ answer, question }) => `<article class="bioquiz-review-item"><strong>Q${question.id}. ${escapeHtml(question.text)}</strong><span class="bioquiz-review-answer">Votre réponse : ${letters[answer.selected]}. ${escapeHtml(question.options[answer.selected])}</span><br><span class="bioquiz-review-correct">Bonne réponse : ${letters[question.answer]}. ${escapeHtml(question.options[question.answer])}</span><div class="bioquiz-explanation" dir="auto">${escapeHtml(question.explanation)}</div></article>`).join('')}</div></section>` : '<p class="quiet">Excellent, aucune erreur à revoir dans cette tentative.</p>';
    content.innerHTML = `<div class="bioquiz-top"><button class="bioquiz-back" id="bioQuizBack" type="button">‹ &nbsp;Retour aux cours</button><span class="bioquiz-course-tag">${escapeHtml(currentLesson.title)}</span></div><div class="bioquiz-result"><div class="bioquiz-result-mark" aria-hidden="true">${percentage >= 50 ? '✓' : '↻'}</div><h3 id="bioQuizTitle">Résultat du QCM</h3><p class="bioquiz-result-score">${correctCount} / ${quizQuestions.length} bonnes réponses · ${percentage}%</p><div class="bioquiz-stats"><span class="bioquiz-stat"><strong>${correctCount}</strong>correctes</span><span class="bioquiz-stat"><strong>${wrongQuestions.length}</strong>fausses</span></div>${wrongHtml}<div class="bioquiz-result-actions"><button class="btn primary" id="bioQuizRestart" type="button">Recommencer le QCM</button><button class="btn" id="bioQuizBackToLessons" type="button">Retour aux cours</button></div></div>`;
    document.getElementById('bioQuizBack').onclick = closeQuiz;
    document.getElementById('bioQuizBackToLessons').onclick = closeQuiz;
    document.getElementById('bioQuizRestart').onclick = () => openQuiz(currentLesson.key);
  }

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    lessonsWrap.hidden = expanded;
  });

  document.querySelectorAll('[data-bio-lesson]').forEach(button => {
    button.addEventListener('click', () => openQuiz(button.dataset.bioLesson));
  });

  modal.addEventListener('click', event => {
    if (event.target === modal) closeQuiz();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal.classList.contains('open')) {
      event.stopPropagation();
      closeQuiz();
    }
  });
})();
