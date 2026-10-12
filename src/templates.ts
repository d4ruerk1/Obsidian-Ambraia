import { App, Modal, normalizePath, Notice, Platform, setIcon, TFile, TFolder } from 'obsidian';
import type AmbraiaPlugin from './main';
import { tx } from './i18n';
import { applyTemplate } from './calendar/dates';
import { availablePath, moment, sanitizeFileName } from './ui/util';

/**
 * Built-in page templates ("modelli"). Plain Markdown with a small frontmatter (type, tags,
 * creation date, icon): readable anywhere, easy to search, and well structured for AI tools.
 * Placeholders: {{title}}, {{date}}, {{date:FORMAT}}, {{time}}, {{yesterday}}, {{tomorrow}}.
 */
export interface Template {
	id: string;
	name: string;
	desc: string;
	icon: string;
	group: string;
	/** Category id (gallery filters): built-in group, or "mine" for the user's templates. */
	groupId?: string;
	/** Default file name ({{date}} allowed). */
	title?: string;
	body: () => string;
	/** A note of the user's templates folder. */
	file?: TFile;
}

const fm = (type: string, icon: string, tags: string[], extra: Record<string, string> = {}) =>
	['---', `type: ${type}`, `icon: ${icon}`, `created: {{date:YYYY-MM-DD}}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`), 'tags:', ...tags.map((t) => `  - ${t}`), '---', ''].join('\n');

/** Small Markdown helpers: every template is a list of lines. */
const h = (s: string) => `## ${s}`;
const task = (s = '') => `- [ ] ${s}`.trimEnd();
const li = (s = '') => `- ${s}`.trimEnd();
const field = (s: string) => `**${s}:** `;
const quote = (s: string) => `> ${s}`;
const callout = (kind: string, title: string, text = '') => [`> [!${kind}] ${title}`, ...(text ? [`> ${text}`] : [])].join('\n');
const table = (cols: string[], rows = 1, align: string[] = []) =>
	[`| ${cols.join(' | ')} |`, `| ${cols.map((_, i) => align[i] ?? '---').join(' | ')} |`, ...Array.from({ length: rows }, () => `| ${cols.map(() => ' ').join(' | ')} |`)].join('\n');
/** A section: title, then its lines, then a blank line. */
const sec = (title: string, ...lines: string[]) => [h(title), ...lines, ''];
const doc = (...parts: (string | string[])[]) => parts.flat().join('\n');

type Def = Omit<Template, 'group' | 'body'> & { body: () => string };

/** Categories, in the order shown by the gallery. */
export const TEMPLATE_GROUPS = () => [
	{ id: 'work', name: tx('Lavoro'), icon: 'briefcase' },
	{ id: 'plan', name: tx('Pianificazione'), icon: 'calendar-range' },
	{ id: 'life', name: tx('Vita personale'), icon: 'heart' },
	{ id: 'study', name: tx('Studio'), icon: 'graduation-cap' },
	{ id: 'write', name: tx('Scrittura e creatività'), icon: 'pen-tool' },
	{ id: 'know', name: tx('Conoscenza'), icon: 'library' },
];

function work(): Def[] {
	return [
		{
			id: 'meeting',
			name: tx('Riunione'),
			desc: tx('Agenda, appunti, decisioni e azioni con responsabile e scadenza.'),
			icon: '🗣️',
			title: tx('Riunione {{date:YYYY-MM-DD}}'),
			body: () =>
				doc(
					fm('meeting', '🗣️', ['riunione'], { date: '{{date:YYYY-MM-DD}}', participants: '[]' }),
					field(tx('Data')) + '{{date:D MMMM YYYY}} · {{time}}',
					field(tx('Partecipanti')),
					'',
					sec(tx('Agenda'), '1. '),
					sec(tx('Appunti'), li()),
					sec(tx('Decisioni'), li()),
					sec(tx('Azioni'), task(tx('Cosa · chi · entro quando'))),
				),
		},
		{
			id: 'one-on-one',
			name: tx('Colloquio 1:1'),
			desc: tx('Incontro individuale ricorrente: aggiornamenti, ostacoli, feedback e crescita.'),
			icon: '🤝',
			title: tx('1:1 {{date:YYYY-MM-DD}}'),
			body: () =>
				doc(
					fm('one-on-one', '🤝', ['1-1'], { date: '{{date:YYYY-MM-DD}}', with: '' }),
					sec(tx('Come va?'), li()),
					sec(tx('Aggiornamenti'), li()),
					sec(tx('Ostacoli'), li()),
					sec(tx('Feedback'), `- ${tx('Da dare')}: `, `- ${tx('Da ricevere')}: `),
					sec(tx('Crescita e obiettivi'), li()),
					sec(tx('Prossimi passi'), task()),
				),
		},
		{
			id: 'project',
			name: tx('Progetto'),
			desc: tx('Obiettivo, contesto, tappe con scadenze, rischi e attività.'),
			icon: '🚀',
			body: () =>
				doc(
					fm('project', '🚀', ['progetto'], { status: tx('in corso'), deadline: '' }),
					quote(tx('In una frase: che cosa vogliamo ottenere e perché.')),
					'',
					sec(tx('Obiettivo')),
					sec(tx('Contesto')),
					sec(tx('Tappe'), table([tx('Tappa'), tx('Scadenza'), tx('Stato')])),
					sec(tx('Rischi'), li()),
					sec(tx('Attività'), task()),
					sec(tx('Risorse'), li()),
				),
		},
		{
			id: 'brief',
			name: tx('Brief per un cliente'),
			desc: tx('Richiesta di un cliente: obiettivi, pubblico, consegne, budget e tempi.'),
			icon: '📋',
			body: () =>
				doc(
					fm('brief', '📋', ['brief'], { client: '', deadline: '', budget: '' }),
					field(tx('Cliente')),
					field(tx('Referente')),
					'',
					sec(tx('Richiesta')),
					sec(tx('Pubblico')),
					sec(tx('Consegne'), task()),
					sec(tx('Tempi e budget'), table([tx('Fase'), tx('Data'), tx('Costo')], 1, ['---', '---', '---:'])),
					sec(tx('Domande aperte'), li()),
				),
		},
		{
			id: 'status',
			name: tx('Report di avanzamento'),
			desc: tx('Stato del lavoro a colpo d’occhio: semaforo, fatto, prossimo, rischi.'),
			icon: '📊',
			title: tx('Report {{date:YYYY-MM-DD}}'),
			body: () =>
				doc(
					fm('status-report', '📊', ['report'], { date: '{{date:YYYY-MM-DD}}', status: tx('in linea') }),
					callout('success', tx('Stato: in linea'), tx('Cambia in “a rischio” o “in ritardo” se serve.')),
					'',
					sec(tx('Fatto'), li()),
					sec(tx('Prossimi passi'), li()),
					sec(tx('Rischi e richieste di aiuto'), li()),
					sec(tx('Numeri'), table([tx('Indicatore'), tx('Valore'), tx('Variazione')])),
				),
		},
		{
			id: 'decision',
			name: tx('Decisione'),
			desc: tx('Registro di una decisione: contesto, opzioni a confronto, scelta e conseguenze.'),
			icon: '⚖️',
			body: () =>
				doc(
					fm('decision', '⚖️', ['decisione'], { status: tx('proposta'), date: '{{date:YYYY-MM-DD}}' }),
					sec(tx('Contesto')),
					sec(tx('Opzioni'), table([tx('Opzione'), tx('Pro'), tx('Contro')], 2)),
					sec(tx('Decisione')),
					sec(tx('Conseguenze'), li()),
				),
		},
		{
			id: 'retro',
			name: tx('Retrospettiva'),
			desc: tx('Fine di un ciclo di lavoro: cosa tenere, cosa cambiare, cosa provare.'),
			icon: '🔁',
			body: () => doc(fm('retrospective', '🔁', ['retrospettiva']), sec(tx('Da continuare'), li()), sec(tx('Da smettere'), li()), sec(tx('Da provare'), li()), sec(tx('Azioni'), task())),
		},
		{
			id: 'swot',
			name: tx('Analisi SWOT'),
			desc: tx('Punti di forza, debolezze, opportunità e minacce in quattro riquadri.'),
			icon: '🧮',
			body: () =>
				doc(
					fm('swot', '🧮', ['analisi']),
					table([`💪 ${tx('Punti di forza')}`, `⚠️ ${tx('Debolezze')}`], 3),
					'',
					table([`🌱 ${tx('Opportunità')}`, `🌩️ ${tx('Minacce')}`], 3),
					'',
					sec(tx('Conclusioni'), li()),
				),
		},
		{
			id: 'bug',
			name: tx('Segnalazione di problema'),
			desc: tx('Passi per riprodurre, risultato atteso e ottenuto, ambiente.'),
			icon: '🐞',
			body: () =>
				doc(
					fm('issue', '🐞', ['problema'], { severity: tx('media'), status: tx('aperto') }),
					sec(tx('Passi per riprodurre'), '1. '),
					sec(tx('Risultato atteso')),
					sec(tx('Risultato ottenuto')),
					sec(tx('Ambiente'), `- ${tx('Versione')}: `, `- ${tx('Dispositivo')}: `),
				),
		},
		{
			id: 'interview',
			name: tx('Colloquio di selezione'),
			desc: tx('Valutazione di un candidato: domande, punteggi e decisione finale.'),
			icon: '🧑‍💼',
			body: () =>
				doc(
					fm('interview', '🧑‍💼', ['selezione'], { role: '', date: '{{date:YYYY-MM-DD}}' }),
					field(tx('Candidato')),
					field(tx('Ruolo')),
					'',
					sec(tx('Domande'), '1. '),
					sec(tx('Valutazione'), table([tx('Area'), tx('Voto (1–5)'), tx('Note')], 3)),
					sec(tx('Decisione'), task(tx('Avanti')), task(tx('No'))),
				),
		},
		{
			id: 'person',
			name: tx('Contatto'),
			desc: tx('Scheda di una persona: ruolo, recapiti, argomenti e storico degli incontri.'),
			icon: '👤',
			body: () =>
				doc(
					fm('person', '👤', ['persona'], { role: '', company: '', email: '' }),
					field(tx('Ruolo')),
					field(tx('Come ci siamo conosciuti')),
					'',
					sec(tx('Argomenti'), li()),
					sec(tx('Incontri'), `- {{date:YYYY-MM-DD}}: `),
				),
		},
	];
}

function plan(): Def[] {
	return [
		{
			id: 'tasks',
			name: tx('Lista di attività'),
			desc: tx('Attività divise per priorità, con caselle da spuntare.'),
			icon: '✅',
			body: () => doc(fm('tasks', '✅', ['attivita']), sec(tx('Priorità alta'), task()), sec(tx('Da fare'), task()), sec(tx('In attesa'), task()), sec(tx('Fatto'))),
		},
		{
			id: 'eisenhower',
			name: tx('Matrice delle priorità'),
			desc: tx('Metodo Eisenhower: urgente e importante, da pianificare, da delegare, da eliminare.'),
			icon: '🧭',
			body: () =>
				doc(
					fm('priorities', '🧭', ['priorita']),
					sec(`🔥 ${tx('Urgente e importante: fallo ora')}`, task()),
					sec(`📆 ${tx('Importante, non urgente: pianificalo')}`, task()),
					sec(`🤝 ${tx('Urgente, non importante: delegalo')}`, task()),
					sec(`🗑️ ${tx('Né urgente né importante: lascialo')}`, task()),
				),
		},
		{
			id: 'week-plan',
			name: tx('Piano della settimana'),
			desc: tx('Un obiettivo per la settimana e le attività divise per giorno.'),
			icon: '🗓️',
			title: tx('Settimana {{date:gggg-[W]ww}}'),
			body: () =>
				doc(
					fm('week-plan', '🗓️', ['settimana'], { week: '{{date:gggg-[W]ww}}' }),
					callout('tip', tx('Obiettivo della settimana')),
					'',
					...[tx('Lunedì'), tx('Martedì'), tx('Mercoledì'), tx('Giovedì'), tx('Venerdì'), tx('Weekend')].map((d) => sec(d, task())),
				),
		},
		{
			id: 'weekly',
			name: tx('Revisione settimanale'),
			desc: tx('Guardarsi indietro: risultati, lezioni imparate, cosa resta e piano successivo.'),
			icon: '🔍',
			title: tx('Revisione {{date:gggg-[W]ww}}'),
			body: () =>
				doc(
					fm('weekly-review', '🔍', ['revisione'], { week: '{{date:gggg-[W]ww}}' }),
					sec(tx('Risultati'), li()),
					sec(tx('Cosa ho imparato'), li()),
					sec(tx('Cosa è rimasto indietro'), task()),
					sec(tx('Piano per la prossima settimana'), task()),
				),
		},
		{
			id: 'month',
			name: tx('Piano del mese'),
			desc: tx('Tema del mese, tre obiettivi, date importanti e bilancio finale.'),
			icon: '🌙',
			title: '{{date:MMMM YYYY}}',
			body: () =>
				doc(
					fm('month-plan', '🌙', ['mese'], { month: '{{date:YYYY-MM}}' }),
					field(tx('Tema del mese')),
					'',
					sec(tx('Tre obiettivi'), task(), task(), task()),
					sec(tx('Date importanti'), table([tx('Data'), tx('Cosa')], 2)),
					sec(tx('Bilancio di fine mese')),
				),
		},
		{
			id: 'goals',
			name: tx('Obiettivi (OKR)'),
			desc: tx('Obiettivi ambiziosi con risultati chiave misurabili e avanzamento.'),
			icon: '🎯',
			body: () =>
				doc(
					fm('goals', '🎯', ['obiettivi'], { period: '{{date:YYYY}}' }),
					sec(tx('Obiettivo 1'), table([tx('Risultato chiave'), tx('Partenza'), tx('Traguardo'), tx('Oggi')], 2)),
					sec(tx('Obiettivo 2'), table([tx('Risultato chiave'), tx('Partenza'), tx('Traguardo'), tx('Oggi')], 2)),
					sec(tx('Perché è importante')),
				),
		},
		{
			id: 'event',
			name: tx('Organizzazione di un evento'),
			desc: tx('Festa, cena o conferenza: invitati, cose da preparare, fornitori e costi.'),
			icon: '🎉',
			body: () =>
				doc(
					fm('event', '🎉', ['evento'], { date: '', place: '' }),
					field(tx('Quando')),
					field(tx('Dove')),
					'',
					sec(tx('Invitati'), table([tx('Nome'), tx('Conferma')], 3)),
					sec(tx('Da preparare'), task()),
					sec(tx('Fornitori e costi'), table([tx('Voce'), tx('Contatto'), tx('Importo')], 2, ['---', '---', '---:'])),
				),
		},
		{
			id: 'travel',
			name: tx('Viaggio'),
			desc: tx('Itinerario giorno per giorno, prenotazioni, bagaglio e budget.'),
			icon: '🧳',
			body: () =>
				doc(
					fm('trip', '🧳', ['viaggio'], { start: '', end: '', destination: '' }),
					sec(tx('Itinerario'), table([tx('Giorno'), tx('Luogo'), tx('Programma')], 2)),
					sec(tx('Prenotazioni'), li()),
					sec(tx('Bagaglio'), task(tx('Documenti')), task(tx('Caricabatterie')), task(tx('Medicine'))),
					sec(tx('Budget'), table([tx('Voce'), tx('Importo')], 1, ['---', '---:'])),
				),
		},
	];
}

function life(): Def[] {
	return [
		{
			id: 'daily',
			name: tx('Diario del giorno'),
			desc: tx('Tre priorità, appunti liberi, gratitudine e bilancio della giornata.'),
			icon: '🌅',
			title: '{{date:YYYY-MM-DD}}',
			body: () =>
				doc(
					fm('journal', '🌅', ['diario'], { date: '{{date:YYYY-MM-DD}}' }),
					sec(tx('Tre priorità'), task(), task(), task()),
					sec(tx('Appunti'), li()),
					sec(tx('Gratitudine'), li()),
					sec(tx('Bilancio della giornata'), `- ${tx('Cosa è andato bene')}: `, `- ${tx('Cosa migliorare')}: `),
				),
		},
		{
			id: 'gratitude',
			name: tx('Diario in 5 minuti'),
			desc: tx('Mattina e sera, poche domande guidate: per chi vuole un’abitudine leggera.'),
			icon: '☀️',
			title: tx('Diario {{date:YYYY-MM-DD}}'),
			body: () =>
				doc(
					fm('five-minute-journal', '☀️', ['diario'], { date: '{{date:YYYY-MM-DD}}' }),
					sec(`🌤️ ${tx('Mattina')}`, `1. ${tx('Sono grato per…')} `, `2. ${tx('Cosa renderebbe ottima la giornata?')} `, `3. ${tx('Un’intenzione per oggi')}: `),
					sec(`🌙 ${tx('Sera')}`, `1. ${tx('Tre cose belle di oggi')}: `, `2. ${tx('Cosa avrei potuto fare meglio?')} `),
				),
		},
		{
			id: 'habits',
			name: tx('Abitudini'),
			desc: tx('Tabella della settimana per segnare le abitudini giorno per giorno.'),
			icon: '🌱',
			body: () => {
				const days = [tx('Lun'), tx('Mar'), tx('Mer'), tx('Gio'), tx('Ven'), tx('Sab'), tx('Dom')];
				return doc(
					fm('habits', '🌱', ['abitudini'], { week: '{{date:gggg-[W]ww}}' }),
					`| ${tx('Abitudine')} | ${days.join(' | ')} |`,
					`| --- | ${days.map(() => ':---:').join(' | ')} |`,
					...[tx('Leggere'), tx('Movimento'), tx('Acqua'), tx('Dormire 7 ore')].map((x) => `| ${x} | ${days.map(() => ' ').join(' | ')} |`),
					'',
				);
			},
		},
		{
			id: 'workout',
			name: tx('Allenamento'),
			desc: tx('Esercizi con serie, ripetizioni e carico; sensazioni a fine sessione.'),
			icon: '🏋️',
			title: tx('Allenamento {{date:YYYY-MM-DD}}'),
			body: () =>
				doc(
					fm('workout', '🏋️', ['allenamento'], { date: '{{date:YYYY-MM-DD}}', duration: '' }),
					sec(tx('Riscaldamento'), li()),
					sec(tx('Esercizi'), table([tx('Esercizio'), tx('Serie'), tx('Ripetizioni'), tx('Carico')], 4)),
					sec(tx('Come mi sono sentito')),
				),
		},
		{
			id: 'health',
			name: tx('Visita medica'),
			desc: tx('Sintomi, domande da fare, esito, terapia e prossimo controllo.'),
			icon: '🩺',
			body: () =>
				doc(
					fm('medical-visit', '🩺', ['salute'], { date: '{{date:YYYY-MM-DD}}', doctor: '' }),
					sec(tx('Sintomi e motivo della visita'), li()),
					sec(tx('Domande da fare'), task()),
					sec(tx('Esito')),
					sec(tx('Terapia'), table([tx('Farmaco'), tx('Dose'), tx('Quando')])),
					field(tx('Prossimo controllo')),
				),
		},
		{
			id: 'meal-plan',
			name: tx('Menu della settimana'),
			desc: tx('Pranzi e cene dei sette giorni, con la lista della spesa che ne deriva.'),
			icon: '🥗',
			body: () =>
				doc(
					fm('meal-plan', '🥗', ['cucina'], { week: '{{date:gggg-[W]ww}}' }),
					table([tx('Giorno'), tx('Pranzo'), tx('Cena')], 7),
					'',
					sec(tx('Lista della spesa'), task()),
				),
		},
		{
			id: 'shopping',
			name: tx('Lista della spesa'),
			desc: tx('Divisa per reparto, per fare la spesa in fretta.'),
			icon: '🛒',
			body: () =>
				doc(
					fm('shopping-list', '🛒', ['spesa']),
					sec(`🥦 ${tx('Frutta e verdura')}`, task()),
					sec(`🧀 ${tx('Frigo')}`, task()),
					sec(`🍞 ${tx('Dispensa')}`, task()),
					sec(`🧴 ${tx('Casa e igiene')}`, task()),
				),
		},
		{
			id: 'recipe',
			name: tx('Ricetta'),
			desc: tx('Ingredienti da spuntare, procedimento numerato, tempi e porzioni.'),
			icon: '🍝',
			body: () =>
				doc(
					fm('recipe', '🍝', ['ricetta'], { servings: '', time: '' }),
					field(tx('Porzioni')) + ' · ' + field(tx('Tempo')),
					'',
					sec(tx('Ingredienti'), task()),
					sec(tx('Procedimento'), '1. '),
					sec(tx('Note')),
				),
		},
		{
			id: 'budget',
			name: tx('Budget mensile'),
			desc: tx('Entrate, uscite per categoria e obiettivo di risparmio del mese.'),
			icon: '💶',
			title: tx('Budget {{date:MMMM YYYY}}'),
			body: () =>
				doc(
					fm('budget', '💶', ['budget'], { month: '{{date:YYYY-MM}}' }),
					sec(tx('Entrate'), table([tx('Voce'), tx('Importo')], 1, ['---', '---:'])),
					sec(tx('Uscite'), table([tx('Voce'), tx('Categoria'), tx('Importo')], 1, ['---', '---', '---:'])),
					sec(tx('Obiettivo di risparmio')),
				),
		},
		{
			id: 'wishlist',
			name: tx('Lista dei desideri'),
			desc: tx('Cose da comprare o regalare, con prezzo, link e priorità.'),
			icon: '🎁',
			body: () => doc(fm('wishlist', '🎁', ['desideri']), table([tx('Cosa'), tx('Prezzo'), tx('Link'), tx('Priorità')], 3, ['---', '---:', '---', '---'])),
		},
		{
			id: 'watch',
			name: tx('Film o serie'),
			desc: tx('Scheda con regia, genere, valutazione a stelle e commento.'),
			icon: '🎬',
			body: () =>
				doc(
					fm('media', '🎬', ['film'], { director: '', year: '', rating: '' }),
					field(tx('Regia')) + ' · ' + field(tx('Genere')) + ' · ' + field(tx('Valutazione')) + '☆☆☆☆☆',
					'',
					sec(tx('Trama in breve')),
					sec(tx('Commento')),
				),
		},
	];
}

function study(): Def[] {
	return [
		{
			id: 'study',
			name: tx('Appunti Cornell'),
			desc: tx('Domande chiave a lato, appunti, riassunto finale e cose da ripassare.'),
			icon: '🎓',
			body: () =>
				doc(
					fm('study-notes', '🎓', ['studio'], { subject: '' }),
					field(tx('Materia')) + ' · ' + field(tx('Data')) + '{{date:D MMMM YYYY}}',
					'',
					sec(tx('Domande chiave'), li()),
					sec(tx('Appunti'), li()),
					sec(tx('Riassunto')),
					sec(tx('Da ripassare'), task()),
				),
		},
		{
			id: 'flashcards',
			name: tx('Schede di ripasso'),
			desc: tx('Domande con la risposta nascosta: aprila solo dopo aver provato a rispondere.'),
			icon: '🃏',
			body: () => doc(fm('flashcards', '🃏', ['ripasso']), ...[1, 2, 3].map(() => [callout('question', tx('Domanda')), '> ', '', '> [!success]- ' + tx('Risposta'), '> ', ''].join('\n'))),
		},
		{
			id: 'exam',
			name: tx('Preparazione esame'),
			desc: tx('Argomenti con stato di avanzamento, calendario di studio e dubbi da chiarire.'),
			icon: '📝',
			body: () =>
				doc(
					fm('exam', '📝', ['esame'], { date: '', subject: '' }),
					field(tx('Data dell’esame')),
					'',
					sec(tx('Argomenti'), table([tx('Argomento'), tx('Studiato'), tx('Ripassato')], 4, ['---', ':---:', ':---:'])),
					sec(tx('Calendario di studio'), task()),
					sec(tx('Dubbi da chiarire'), li()),
				),
		},
		{
			id: 'paper',
			name: tx('Articolo scientifico'),
			desc: tx('Lettura critica di una pubblicazione: domanda, metodo, risultati, limiti.'),
			icon: '🔬',
			body: () =>
				doc(
					fm('paper', '🔬', ['ricerca'], { authors: '', year: '', doi: '' }),
					sec(tx('Domanda di ricerca')),
					sec(tx('Metodo')),
					sec(tx('Risultati principali'), li()),
					sec(tx('Limiti')),
					sec(tx('Cosa mi serve'), li()),
				),
		},
		{
			id: 'book',
			name: tx('Scheda di lettura'),
			desc: tx('Libro: autore, valutazione, idee principali, citazioni e opinione.'),
			icon: '📚',
			body: () =>
				doc(
					fm('book', '📚', ['lettura'], { author: '', rating: '', status: tx('da leggere') }),
					field(tx('Autore')),
					field(tx('Valutazione')) + '☆☆☆☆☆',
					'',
					sec(tx('In breve')),
					sec(tx('Idee principali'), li()),
					sec(tx('Citazioni'), quote('')),
					sec(tx('Cosa ne penso')),
				),
		},
		{
			id: 'language',
			name: tx('Vocabolario'),
			desc: tx('Parole nuove di una lingua con significato ed esempio d’uso.'),
			icon: '🌐',
			body: () => doc(fm('vocabulary', '🌐', ['lingue'], { language: '' }), table([tx('Parola'), tx('Significato'), tx('Esempio')], 5)),
		},
		{
			id: 'course',
			name: tx('Corso online'),
			desc: tx('Lezioni da seguire con avanzamento, appunti per modulo e progetto finale.'),
			icon: '💻',
			body: () =>
				doc(
					fm('course', '💻', ['corso'], { platform: '', url: '' }),
					sec(tx('Lezioni'), task(tx('Modulo 1')), task(tx('Modulo 2')), task(tx('Modulo 3'))),
					sec(tx('Appunti'), li()),
					sec(tx('Progetto finale')),
				),
		},
		{
			id: 'lesson-plan',
			name: tx('Piano di lezione'),
			desc: tx('Per chi insegna: obiettivi, materiali, attività con i tempi e verifica.'),
			icon: '🧑‍🏫',
			body: () =>
				doc(
					fm('lesson-plan', '🧑‍🏫', ['lezione'], { date: '{{date:YYYY-MM-DD}}' }),
					sec(tx('Obiettivi'), li()),
					sec(tx('Materiali'), li()),
					sec(tx('Attività'), `1. ${tx('Introduzione')} (10 min)`, `2. ${tx('Attività principale')} (30 min)`, `3. ${tx('Conclusione')} (10 min)`),
					sec(tx('Verifica')),
				),
		},
	];
}

function write(): Def[] {
	return [
		{
			id: 'article',
			name: tx('Articolo'),
			desc: tx('Dall’idea alla pubblicazione: messaggio, scaletta, testo e revisione.'),
			icon: '✍️',
			body: () =>
				doc(
					fm('draft', '✍️', ['scrittura'], { status: tx('bozza') }),
					quote(tx('Il messaggio principale in una frase.')),
					'',
					sec(tx('Scaletta'), '1. '),
					sec(tx('Testo')),
					sec(tx('Revisione'), task(tx('Titolo e introduzione')), task(tx('Fonti e link')), task(tx('Rilettura finale'))),
				),
		},
		{
			id: 'social',
			name: tx('Post per i social'),
			desc: tx('Gancio, testo, invito all’azione e hashtag, con la data di pubblicazione.'),
			icon: '📣',
			body: () =>
				doc(
					fm('social-post', '📣', ['social'], { platform: '', publish: '' }),
					sec(tx('Gancio'), quote('')),
					sec(tx('Testo')),
					sec(tx('Invito all’azione')),
					sec(tx('Hashtag'), '#'),
				),
		},
		{
			id: 'newsletter',
			name: tx('Newsletter'),
			desc: tx('Oggetto, apertura, tre notizie con link e chiusura.'),
			icon: '📬',
			body: () =>
				doc(
					fm('newsletter', '📬', ['newsletter'], { issue: '', send: '' }),
					field(tx('Oggetto')),
					'',
					sec(tx('Apertura')),
					sec(tx('In questo numero'), ...[1, 2, 3].map((n) => `${n}. **${tx('Titolo')}** – `)),
					sec(tx('Chiusura')),
				),
		},
		{
			id: 'video-script',
			name: tx('Copione video o podcast'),
			desc: tx('Scene o segmenti con durata, parlato e note per immagini e suoni.'),
			icon: '🎙️',
			body: () =>
				doc(
					fm('script', '🎙️', ['copione'], { duration: '' }),
					sec(tx('Idea')),
					sec(tx('Copione'), table([tx('Tempo'), tx('Parlato'), tx('Immagini e suoni')], 4)),
					sec(tx('Da preparare'), task()),
				),
		},
		{
			id: 'character',
			name: tx('Personaggio'),
			desc: tx('Per racconti e romanzi: aspetto, carattere, desideri, paure e relazioni.'),
			icon: '🎭',
			body: () =>
				doc(
					fm('character', '🎭', ['personaggio'], { story: '' }),
					sec(tx('Aspetto')),
					sec(tx('Carattere')),
					sec(tx('Cosa desidera')),
					sec(tx('Di cosa ha paura')),
					sec(tx('Relazioni'), li()),
				),
		},
		{
			id: 'moodboard',
			name: tx('Moodboard'),
			desc: tx('Raccolta visiva di immagini, colori e riferimenti per un progetto creativo.'),
			icon: '🎨',
			body: () => doc(fm('moodboard', '🎨', ['ispirazione']), sec(tx('Immagini'), tx('Trascina qui le immagini.')), sec(tx('Colori'), li('#')), sec(tx('Riferimenti'), li())),
		},
	];
}

function know(): Def[] {
	return [
		{
			id: 'idea',
			name: tx('Idea'),
			desc: tx('Brainstorming: problema, idee, pro e contro, prossimi passi.'),
			icon: '💡',
			body: () => doc(fm('idea', '💡', ['idea']), sec(tx('Il problema')), sec(tx('Idee'), li()), sec(tx('Pro'), li()), sec(tx('Contro'), li()), sec(tx('Prossimi passi'), task())),
		},
		{
			id: 'zettel',
			name: tx('Nota permanente'),
			desc: tx('Metodo Zettelkasten: un solo concetto con parole tue, fonte e collegamenti.'),
			icon: '🗃️',
			body: () => doc(fm('permanent-note', '🗃️', ['zettel']), sec(tx('Concetto')), sec(tx('Fonte')), sec(tx('Collegamenti'), li('[[]]'))),
		},
		{
			id: 'howto',
			name: tx('Guida passo passo'),
			desc: tx('Istruzioni da seguire: requisiti, passaggi numerati e problemi comuni.'),
			icon: '📖',
			body: () =>
				doc(
					fm('how-to', '📖', ['guida']),
					callout('info', tx('A cosa serve')),
					'',
					sec(tx('Ti serve'), li()),
					sec(tx('Passaggi'), '1. ', '2. ', '3. '),
					sec(tx('Problemi comuni'), li()),
				),
		},
		{
			id: 'compare',
			name: tx('Confronto'),
			desc: tx('Due o più alternative a confronto su criteri con peso e voto.'),
			icon: '🆚',
			body: () =>
				doc(
					fm('comparison', '🆚', ['confronto']),
					table([tx('Criterio'), tx('Peso'), tx('Opzione A'), tx('Opzione B')], 4, ['---', ':---:', ':---:', ':---:']),
					'',
					sec(tx('Scelta')),
				),
		},
		{
			id: 'snippet',
			name: tx('Frammento di codice'),
			desc: tx('Codice da riutilizzare con spiegazione, esempio d’uso e fonte.'),
			icon: '🧑‍💻',
			body: () => doc(fm('snippet', '🧑‍💻', ['codice'], { language: '' }), sec(tx('A cosa serve')), sec(tx('Codice'), '```', '', '```'), sec(tx('Esempio')), sec(tx('Fonte'))),
		},
		{
			id: 'resource',
			name: tx('Risorsa web'),
			desc: tx('Un link da conservare: perché è utile, punti salienti e dove usarlo.'),
			icon: '🔗',
			body: () => doc(fm('resource', '🔗', ['risorsa'], { url: '' }), sec(tx('Perché è utile')), sec(tx('Punti salienti'), li()), sec(tx('Dove usarlo'), li('[[]]'))),
		},
	];
}

export function builtinTemplates(): Template[] {
	const groups = TEMPLATE_GROUPS();
	const sets: [string, Def[]][] = [
		['work', work()],
		['plan', plan()],
		['life', life()],
		['study', study()],
		['write', write()],
		['know', know()],
	];
	return sets.flatMap(([g, list]) => list.map((d) => ({ ...d, group: groups.find((x) => x.id === g)!.name, groupId: g })));
}

/** Notes in the folder of Obsidian's "Templates" core plugin, if configured. */
export function userTemplates(app: App): Template[] {
	const core = (app as unknown as { internalPlugins?: { getPluginById?(id: string): { enabled?: boolean; instance?: { options?: { folder?: string } } } | null } }).internalPlugins?.getPluginById?.('templates');
	const folder = core?.enabled ? core.instance?.options?.folder : '';
	if (!folder) return [];
	const f = app.vault.getAbstractFileByPath(normalizePath(folder));
	if (!(f instanceof TFolder)) return [];
	const out: Template[] = [];
	const walk = (d: TFolder) => {
		for (const c of d.children) {
			if (c instanceof TFolder) walk(c);
			else if (c instanceof TFile && c.extension === 'md') out.push({ id: 'file:' + c.path, name: c.basename, desc: c.path, icon: '📄', group: tx('I tuoi modelli'), groupId: 'mine', file: c, body: () => '' });
		}
	};
	walk(f);
	return out;
}

export async function templateText(app: App, t: Template, title: string): Promise<string> {
	const raw = t.file ? await app.vault.cachedRead(t.file) : t.body();
	return applyTemplate(raw, moment(), title, 'YYYY-MM-DD');
}

/** Creates a note from a template in `folder` and opens it (title selected for renaming). */
export async function createFromTemplate(plugin: AmbraiaPlugin, t: Template, folder?: TFolder): Promise<TFile> {
	const app = plugin.app;
	const parent = folder ?? app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? '');
	const title = sanitizeFileName(applyTemplate(t.title ?? t.name, moment(), t.name, 'YYYY-MM-DD')) || tx('Senza titolo');
	const path = availablePath(app, parent.isRoot() ? '' : parent.path, title, 'md');
	const name = path.split('/').pop()!.replace(/\.md$/, '');
	let text = await templateText(app, t, name);
	const key = plugin.settings.iconKey || 'icon';
	if (key !== 'icon') text = text.replace(/^(---\n(?:.*\n)*?)icon: /, `$1${key}: `);
	const f = await app.vault.create(path, text);
	await app.workspace.getLeaf(false).openFile(f, { state: { mode: 'source' }, eState: { rename: 'all' } });
	return f;
}

/** Inserts a template into the active note at the cursor (frontmatter merged as properties). */
export async function insertTemplate(plugin: AmbraiaPlugin, t: Template) {
	const view = plugin.app.workspace.activeEditor;
	const ed = view?.editor;
	const file = view?.file;
	if (!ed || !file) {
		new Notice(tx('Apri una nota per inserire il modello.'));
		return;
	}
	const text = await templateText(plugin.app, t, file.basename);
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	const body = m ? text.slice(m[0].length) : text;
	ed.replaceSelection(body.replace(/^# \{\{title\}\}\n\n?|^# .*\n\n?/, ''));
	if (m) {
		const { parseYaml } = await import('obsidian');
		const props = parseYaml(m[1]) as Record<string, unknown>;
		await plugin.app.fileManager.processFrontMatter(file, (fmo: Record<string, unknown>) => {
			for (const [k, v] of Object.entries(props ?? {})) if (!(k in fmo) && k !== 'created') fmo[k] = v;
		});
	}
}

const RECENT_KEY = 'ambraia-recent-templates';
const fold = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Headings and contents of a template, for the preview (no file is read for built-in ones). */
function outline(t: Template): { heads: string[]; tasks: number; tables: number } {
	const body = t.file ? '' : t.body().replace(/^---\n[\s\S]*?\n---\n/, '');
	const lines = body.split('\n');
	return {
		heads: lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3)),
		tasks: lines.filter((l) => l.startsWith('- [ ]')).length,
		tables: lines.filter((l) => /^\| -{3}|^\| :?-{3}/.test(l)).length,
	};
}

/**
 * Template gallery: categories on the side, cards with icon and description, a live preview of
 * the sections and a search box. Used both to create a new page and to insert into the current one.
 */
export class TemplatePicker extends Modal {
	private all: Template[] = [];
	private shown: Template[] = [];
	private cat = 'all';
	private query = '';
	private sel = 0;
	private gridEl!: HTMLElement;
	private navEl!: HTMLElement;
	private previewEl!: HTMLElement;

	constructor(
		private plugin: AmbraiaPlugin,
		private onPick: (t: Template) => void,
		private insert = false,
	) {
		super(plugin.app);
	}

	private recent(): string[] {
		const v = (this.app as unknown as { loadLocalStorage?(k: string): unknown }).loadLocalStorage?.(RECENT_KEY);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	}

	onOpen() {
		this.modalEl.addClass('ambraia-tpl-modal');
		this.titleEl.setText(this.insert ? tx('Inserisci un modello') : tx('Galleria modelli'));
		this.all = [...userTemplates(this.app), ...builtinTemplates()];
		const el = this.contentEl;
		el.empty();
		const search = el.createDiv('ambraia-tpl-search');
		setIcon(search.createSpan('ambraia-tpl-search-icon'), 'search');
		const input = search.createEl('input', { type: 'search', attr: { placeholder: tx('Cerca tra {0} modelli…', this.all.length), 'aria-label': tx('Cerca un modello') } });
		input.addEventListener('input', () => {
			this.query = input.value;
			this.sel = 0;
			this.draw();
		});
		input.addEventListener('keydown', (e) => this.onKey(e));
		const body = el.createDiv('ambraia-tpl-body');
		this.navEl = body.createDiv({ cls: 'ambraia-tpl-nav', attr: { role: 'tablist' } });
		this.gridEl = body.createDiv({ cls: 'ambraia-tpl-grid', attr: { role: 'listbox' } });
		this.previewEl = body.createDiv('ambraia-tpl-preview');
		if (this.recent().length) this.cat = 'recent';
		this.draw();
		window.setTimeout(() => input.focus(), 30);
	}

	private cats(): { id: string; name: string; icon: string; n: number }[] {
		const recent = this.recent();
		const out = [{ id: 'all', name: tx('Tutti'), icon: 'layout-grid', n: this.all.length }];
		if (recent.length) out.push({ id: 'recent', name: tx('Recenti'), icon: 'history', n: recent.filter((id) => this.all.some((t) => t.id === id)).length });
		const mine = this.all.filter((t) => t.groupId === 'mine').length;
		if (mine) out.push({ id: 'mine', name: tx('I tuoi modelli'), icon: 'user', n: mine });
		for (const g of TEMPLATE_GROUPS()) out.push({ ...g, n: this.all.filter((t) => t.groupId === g.id).length });
		return out;
	}

	private filtered(): Template[] {
		const q = fold(this.query.trim());
		if (q) return this.all.filter((t) => fold(`${t.name} ${t.desc} ${t.group}`).includes(q));
		if (this.cat === 'recent') return this.recent().map((id) => this.all.find((t) => t.id === id)).filter((t): t is Template => !!t);
		if (this.cat === 'all') return this.all;
		return this.all.filter((t) => t.groupId === this.cat);
	}

	private draw() {
		const searching = !!this.query.trim();
		this.navEl.empty();
		for (const c of this.cats()) {
			const b = this.navEl.createEl('button', { cls: 'ambraia-tpl-cat', attr: { role: 'tab', 'aria-selected': String(!searching && c.id === this.cat) } });
			b.toggleClass('is-active', !searching && c.id === this.cat);
			setIcon(b.createSpan('ambraia-tpl-cat-icon'), c.icon);
			b.createSpan({ cls: 'ambraia-tpl-cat-name', text: c.name });
			b.createSpan({ cls: 'ambraia-tpl-cat-n', text: String(c.n) });
			b.onclick = () => {
				this.cat = c.id;
				this.sel = 0;
				const inp = this.contentEl.querySelector<HTMLInputElement>('.ambraia-tpl-search input');
				if (inp) inp.value = '';
				this.query = '';
				this.draw();
			};
		}
		this.shown = this.filtered();
		this.gridEl.empty();
		if (!this.shown.length) this.gridEl.createDiv({ cls: 'ambraia-tpl-empty', text: tx('Nessun modello trovato.') });
		let lastGroup = '';
		this.shown.forEach((t, i) => {
			if ((this.cat === 'all' || searching) && t.group !== lastGroup) {
				lastGroup = t.group;
				this.gridEl.createDiv({ cls: 'ambraia-tpl-group', text: t.group });
			}
			const card = this.gridEl.createDiv({ cls: 'ambraia-tpl-card', attr: { role: 'option', tabindex: '-1' } });
			card.dataset.index = String(i);
			card.createDiv({ cls: 'ambraia-tpl-card-icon', text: t.icon });
			const txt = card.createDiv('ambraia-tpl-card-text');
			txt.createDiv({ cls: 'ambraia-tpl-card-name', text: t.name });
			txt.createDiv({ cls: 'ambraia-tpl-card-desc', text: t.desc });
			card.onmouseenter = () => this.select(i, false);
			card.onclick = () => (Platform.isPhone ? this.use(t) : this.select(i, false));
			card.ondblclick = () => this.use(t);
		});
		this.select(Math.min(this.sel, Math.max(0, this.shown.length - 1)), false);
	}

	private select(i: number, scroll = true) {
		this.sel = i;
		this.gridEl.querySelectorAll<HTMLElement>('.ambraia-tpl-card').forEach((c) => {
			const on = c.dataset.index === String(i);
			c.toggleClass('is-selected', on);
			c.setAttr('aria-selected', String(on));
			if (on && scroll) c.scrollIntoView({ block: 'nearest' });
		});
		this.renderPreview(this.shown[i]);
	}

	private renderPreview(t: Template | undefined) {
		const p = this.previewEl;
		p.empty();
		if (!t) return;
		const head = p.createDiv('ambraia-tpl-prev-head');
		head.createDiv({ cls: 'ambraia-tpl-prev-icon', text: t.icon });
		const ht = head.createDiv();
		ht.createDiv({ cls: 'ambraia-tpl-prev-name', text: t.name });
		ht.createDiv({ cls: 'ambraia-tpl-prev-group', text: t.group });
		p.createDiv({ cls: 'ambraia-tpl-prev-desc', text: t.desc });
		const o = outline(t);
		if (o.heads.length) {
			p.createDiv({ cls: 'ambraia-tpl-prev-sub', text: tx('Sezioni') });
			const ul = p.createEl('ul', { cls: 'ambraia-tpl-prev-list' });
			for (const x of o.heads) ul.createEl('li', { text: x });
		}
		const facts: string[] = [];
		if (o.tasks) facts.push(o.tasks === 1 ? tx('1 casella da spuntare') : tx('{0} caselle da spuntare', o.tasks));
		if (o.tables) facts.push(o.tables === 1 ? tx('1 tabella') : tx('{0} tabelle', o.tables));
		if (t.file) facts.push(t.file.path);
		if (facts.length) p.createDiv({ cls: 'ambraia-tpl-prev-facts', text: facts.join(' · ') });
		const b = p.createEl('button', { cls: 'mod-cta ambraia-tpl-use', text: this.insert ? tx('Inserisci') : tx('Crea la pagina') });
		b.onclick = () => this.use(t);
	}

	private onKey(e: KeyboardEvent) {
		const n = this.shown.length;
		if (!n) return;
		const cols = Math.max(1, Math.round(this.gridEl.clientWidth / 230));
		const step: Record<string, number> = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 };
		// with text in the search box, left/right move the caret
		if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.target as HTMLInputElement).value) return;
		if (e.key in step) {
			e.preventDefault();
			this.select(Math.min(n - 1, Math.max(0, this.sel + step[e.key])));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const t = this.shown[this.sel];
			if (t) this.use(t);
		}
	}

	private use(t: Template) {
		const ls = this.app as unknown as { saveLocalStorage?(k: string, v: unknown): void };
		ls.saveLocalStorage?.(RECENT_KEY, [t.id, ...this.recent().filter((x) => x !== t.id)].slice(0, 6));
		this.close();
		this.onPick(t);
	}

	onClose() {
		this.contentEl.empty();
	}
}
