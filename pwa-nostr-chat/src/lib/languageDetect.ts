/**
 * Pure, deterministic language detection & translatability filtering shared
 * between the main UI thread (room-level language hints, skip-non-prose) and
 * the off-main-thread translation worker.
 *
 * Zero dependencies, zero network calls, zero false English fallbacks.
 */

export interface LanguageDetectionResult {
  lang: string | null
  confidence: 'high' | 'medium' | 'low'
  score: number
}

const TRADITIONAL_HAN_RE =
  /[體國臺學機時會來個點這為說們發與後經開關問進動對義無應當產車書長門東風雲龍電愛馬鳥魚麼誰還讓給對錯錢買賣見聽話語讀寫]/g
const SIMPLIFIED_HAN_RE =
  /[体国台学机时会来个点这为说们发与后经开关问进动对义无应当产车书长门东风云龙电爱马鸟鱼么谁还让给对错钱买卖见听话语读写]/g

const BULGARIAN_WORDS = new Set([
  'ще', 'съм', 'който', 'която', 'което', 'това', 'защото', 'много', 'какво',
  'здравей', 'благодаря', 'моля', 'добре', 'тук', 'сега', 'всичко', 'няма',
])

/**
 * Strips fenced/inline code, URLs, Nostr bech32 identifiers, Lightning invoices,
 * Cashu tokens, `@mentions`, and `#channels` so language detection only inspects
 * natural-language prose.
 */
export function stripNonProseForDetection(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/\$\$[^$\n]+\$\$/g, ' ')
    .replace(/\$[^$\n]+\$/g, ' ')
    .replace(/https?:\/\/[^\s<>()]+/gi, ' ')
    .replace(/\bwww\.[^\s<>()]+/gi, ' ')
    .replace(/\bnostr:(?:npub|nsec|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]+\b/gi, ' ')
    .replace(/\b(?:npub|note|nprofile|nevent|naddr)1[02-9ac-hj-np-z]{20,}\b/gi, ' ')
    .replace(/\blnbc[a-z0-9]{20,}\b/gi, ' ')
    .replace(/\bcashu[AB][A-Za-z0-9_\-+=]{20,}\b/g, ' ')
    .replace(/(^|\s)@[A-Za-z0-9_.\-#]+/g, ' ')
    .replace(/(^|\s)#[A-Za-z0-9_-]+/g, ' ')
}

/**
 * Returns true when text contains no translatable natural-language content
 * (empty, code-block-only, URL-only, mention/hashtag-only, Nostr/Lightning/Cashu-only,
 * or pure emoji/numbers/symbols with zero Unicode letters remaining).
 */
export function isNonTranslatableText(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return true
  const stripped = stripNonProseForDetection(trimmed)
  return !/\p{L}/u.test(stripped)
}

// High-signal language-specific lexicons (weight 2.5) and secondary/shared lexicons (weight 1.1)
interface LatinLanguageProfile {
  strong: ReadonlySet<string>
  shared?: ReadonlySet<string>
  trigrams?: readonly string[]
  suffixes?: readonly string[]
}

const LATIN_PROFILES: Record<string, LatinLanguageProfile> = {
  English: {
    strong: new Set([
      'the', 'and', 'you', 'your', 'that', 'this', 'with', 'for', 'are', 'have', 'has', 'had',
      'not', 'but', 'what', 'why', 'how', 'when', 'where', 'who', 'all', 'from', 'they', 'them',
      'their', 'just', 'like', 'about', 'would', 'could', 'should', 'there', 'will', 'can',
      'hello', 'hey', 'hi', 'yo', 'sup', 'thanks', 'thank', 'good', 'great', 'nice', 'awesome',
      'cool', 'please', 'yes', 'yep', 'yeah', 'nope', 'nah', 'really', 'going', 'think', 'know',
      'here', 'been', 'were', 'was', 'its', "it's", "i'm", "don't", 'dont', "can't", 'cant',
      "won't", 'wont', "that's", 'thats', "didn't", "doesn't", "isn't", "aren't", "we're",
      "you're", "they're", 'because', 'lol', 'lmao', 'omg', 'idk', 'tbh', 'brb', 'gm', 'gn',
      'bro', 'dude', 'guys', 'everyone', 'today', 'tomorrow', 'night', 'morning', 'maybe',
      'sure', 'right', 'now', 'very', 'much', 'more', 'some', 'only', 'still', 'actually',
      'doing', 'want', 'need', 'make', 'time', 'people', 'work', 'back', "let's", 'lets',
      'see', 'look', 'wait', 'sorry', 'welcome', 'meet', 'noon', 'working', 'something',
      'nothing', 'anything', 'everything', 'always', 'never', 'already', 'before', 'after',
      'which', 'while', 'wherever', 'trying', 'getting', 'saying', 'check', 'send', 'sent',
      'message', 'chat', 'room', 'channel', 'anyone', 'someone', 'tomorrow', 'yesterday',
      'tonight', 'later', 'soon', 'fine', 'okay', 'sounds', 'pretty', 'though', 'through',
    ]),
    shared: new Set(['no', 'ok', 'so', 'go', 'do', 'to', 'of', 'in', 'on', 'at', 'by', 'up', 'we', 'my', 'me', 'us', 'is', 'be', 'it']),
    trigrams: ['the', 'ing', 'and', 'tha', 'hat', 'you', 'ght', "n't", 'his', 'her', 'ere', 'ent', 'ion', 'wit', 'for'],
    suffixes: ['ing', 'tion', 'ment', 'ness', 'ould', "n't"],
  },
  Spanish: {
    strong: new Set([
      'los', 'las', 'pero', 'cómo', 'está', 'estás', 'están', 'estoy', 'estamos', 'hola',
      'gracias', 'amigo', 'amigos', 'amiga', 'buenos', 'buenas', 'días', 'tardes', 'noches',
      'noche', 'mañana', 'tarde', 'porque', 'también', 'tambien', 'todo', 'todos', 'todas',
      'esta', 'este', 'esto', 'eso', 'muy', 'donde', 'dónde', 'quien', 'quién', 'cuando',
      'cuándo', 'tengo', 'tiene', 'tienes', 'tenemos', 'tienen', 'hacer', 'haciendo', 'puede',
      'puedo', 'puedes', 'podemos', 'quiero', 'quieres', 'quiere', 'queremos', 'algo', 'nada',
      'siempre', 'nunca', 'ahora', 'aquí', 'aqui', 'mucho', 'mucha', 'muchos', 'más', 'mas',
      'sin', 'sobre', 'claro', 'dale', 'vale', 'vamos', 'jajaja', 'jaja', 'genial', 'chao',
      'perdón', 'perdon', 'exacto', 'buen', 'buena', 'día', 'dia', 'qué', 'tal', 'pasa',
      'comer', 'ver', 'bien', 'mal', 'creo', 'sabes', 'sabe', 'mira', 'oye', 'che', 'wey',
      'tío', 'tio', 'joder', 'ostras', 'hermano', 'pana', 'listo', 'seguro', 'entonces',
      'luego', 'después', 'despues', 'antes', 'hoy', 'ayer', 'quién', 'cuál', 'cual', 'cuánto',
      'cuanto', 'cómo', 'dime', 'dijo', 'dice', 'dicen', 'hablar', 'hablando', 'saber', 'decir',
      'venir', 'salir', 'estar', 'soy', 'eres', 'somos', 'son', 'era', 'fue', 'fueron', 'hay',
      'había', 'habia', 'uno', 'unos', 'unas', 'ese', 'esa', 'esos', 'esas', 'nuestro',
      'nuestra', 'vuestro', 'ellos', 'ellas', 'nosotros', 'ustedes', 'vosotros', 'conmigo',
      'contigo', 'todavía', 'todavia', 'ya', 'aún', 'aun', 'solo', 'sólo', 'nuevo', 'nueva',
      'mejor', 'peor', 'grande', 'pequeño', 'tiempo', 'cosa', 'cosas', 'gente', 'vida', 'casa',
      'trabajo', 'hora', 'horas', 'momento', 'verdad', 'favor', 'porfa', 'adios', 'adiós',
      'hasta', 'pronto', 'espera', 'esperando', 'pensando', 'trabajando', 'llegando',
    ]),
    shared: new Set(['que', 'por', 'para', 'con', 'una', 'como', 'si', 'sí', 'no', 'de', 'la', 'el', 'en', 'un', 'al', 'del', 'lo', 'le', 'les', 'te', 'se', 'me', 'mi', 'tu', 'su', 'es', 'y', 'o', 'a']),
    trigrams: ['que', 'est', 'los', 'las', 'ndo', 'mos', 'ado', 'ido', 'cio', 'ión', 'dad', 'por', 'par', 'con', 'ent'],
    suffixes: ['ción', 'sión', 'dad', 'ando', 'iendo', 'amos', 'emos', 'imos', 'mente'],
  },
  French: {
    strong: new Set([
      'les', 'des', 'une', 'qui', 'dans', 'pour', 'pas', 'sur', 'avec', 'plus', 'tout', 'tous',
      'toute', 'toutes', 'mais', 'nous', 'vous', 'sont', 'être', 'etre', 'avoir', 'faire',
      'bonjour', 'bonsoir', 'salut', 'coucou', 'merci', 'beaucoup', 'très', 'tres', 'aussi',
      'peut', 'peux', 'pouvons', 'veux', 'veut', 'voulons', 'suis', 'chez', 'sans', 'donc',
      'alors', 'quand', 'comment', 'pourquoi', 'quoi', 'oui', 'ouais', 'non', "c'est", "j'ai",
      "n'est", "qu'il", "qu'on", "d'accord", 'mdr', 'ptdr', 'toujours', 'jamais', 'ici',
      'maintenant', 'demain', "aujourd'hui", 'hier', 'rien', 'personne', 'vrai', 'vraiment',
      'sympa', 'génial', 'genial', 'bientôt', 'bientot', 'monde', 'encore', 'déjà', 'deja',
      'ça', 'ca', 'voilà', 'voila', 'où', 'ou', 'quel', 'quelle', 'quels', 'quelles', 'notre',
      'votre', 'leur', 'leurs', 'elle', 'elles', 'ils', 'lui', 'eux', 'moi', 'toi', 'soi',
      'cette', 'ces', 'cet', 'celui', 'celle', 'ceux', 'aucun', 'aucune', 'chaque', 'autre',
      'autres', 'même', 'meme', 'peu', 'trop', 'assez', 'moins', 'mieux', 'pire', 'bon',
      'bonne', 'petit', 'grand', 'nouveau', 'nouvelle', 'temps', 'jour', 'soir', 'nuit',
      'matin', 'chose', 'choses', 'gens', 'travail', 'maison', 'ami', 'amis', 'super',
      'parfait', 'désolé', 'desole', 'pardon', 'svp', 'stp', 'allez', 'allons', 'viens',
      'venir', 'voir', 'savoir', 'dire', 'parler', 'manger', 'prendre', 'donner', 'penser',
      'crois', 'sais', 'vais', 'vas', 'fait', 'fais', 'étais', 'etais', 'était', 'etait',
      'sera', 'serait', 'avait', 'aura', 'aurait', 'depuis', 'pendant', 'avant', 'après',
      'apres', 'entre', 'vers', 'contre', 'sous', 'travers', 'parce', 'puisque', 'comme',
    ]),
    shared: new Set(['est', 'que', 'bien', 'va', 'de', 'du', 'la', 'le', 'un', 'en', 'au', 'aux', 'et', 'ou', 'ne', 'se', 'je', 'tu', 'il', 'on', 'ce', 'sa', 'ma', 'ta', 'mon', 'ton', 'son', 'à']),
    trigrams: ['les', 'des', 'ent', 'ion', 'ous', 'ait', 'ais', 'eur', 'que', 'est', 'tou', 'pou', 'dan', 'ave', "c'e"],
    suffixes: ['tion', 'ment', 'eux', 'euse', 'ais', 'ait', 'aient', 'oir', 'eur'],
  },
  German: {
    strong: new Set([
      'der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'ein', 'eine', 'einen', 'einem',
      'einer', 'mit', 'auf', 'für', 'fur', 'von', 'vom', 'den', 'dem', 'des', 'sich', 'auch',
      'als', 'wie', 'aber', 'noch', 'nach', 'über', 'uber', 'bei', 'beim', 'wir', 'ihr',
      'sind', 'war', 'waren', 'haben', 'habe', 'hast', 'hat', 'wird', 'werden', 'kann',
      'kannst', 'können', 'konnen', 'muss', 'musst', 'müssen', 'mussen', 'will', 'willst',
      'wollen', 'soll', 'sollen', 'hallo', 'moin', 'servus', 'tschüss', 'tschuss', 'danke',
      'bitte', 'geht', 'gut', 'sehr', 'hier', 'jetzt', 'heute', 'morgen', 'gestern', 'oder',
      'wenn', 'weil', 'schon', 'immer', 'nein', 'genau', 'alles', 'klar', 'kein', 'keine',
      'keinen', 'doch', 'mal', 'wieso', 'warum', 'wann', 'wer', 'was', 'wo', 'woher', 'wohin',
      'gerne', 'gern', 'krass', 'echt', 'vielleicht', 'wirklich', 'eigentlich', 'natürlich',
      'naturlich', 'einfach', 'schnell', 'langsam', 'groß', 'gross', 'klein', 'neu', 'alt',
      'mehr', 'weniger', 'viel', 'viele', 'wenig', 'alle', 'nichts', 'etwas', 'jemand',
      'niemand', 'mein', 'meine', 'dein', 'deine', 'sein', 'seine', 'unser', 'unsere', 'euer',
      'dich', 'mich', 'euch', 'uns', 'ihm', 'ihn', 'ihnen', 'dies', 'diese', 'dieser', 'dieses',
      'dann', 'denn', 'dass', 'ob', 'bis', 'seit', 'vor', 'hinter', 'unter', 'neben', 'zwischen',
      'durch', 'gegen', 'ohne', 'zum', 'zur', 'ins', 'ans', 'machen', 'macht', 'gemacht',
      'sehen', 'sagen', 'wissen', 'denken', 'kommen', 'gehen', 'essen', 'trinken', 'arbeiten',
      'zeit', 'tag', 'nacht', 'abend', 'leute', 'freund', 'freunde', 'sorry', 'schade', 'prima',
    ]),
    shared: new Set(['ja', 'so', 'zu', 'im', 'in', 'an', 'am', 'es', 'er', 'du', 'da', 'ab', 'super']),
    trigrams: ['sch', 'ich', 'ein', 'cht', 'der', 'die', 'das', 'und', 'ung', 'den', 'ten', 'ver', 'gen', 'ber', 'ach'],
    suffixes: ['ung', 'keit', 'heit', 'lich', 'isch', 'chen', 'lein', 'schaft'],
  },
  Portuguese: {
    strong: new Set([
      'não', 'nao', 'mais', 'mas', 'foi', 'são', 'sao', 'está', 'estou', 'estamos', 'estão',
      'estao', 'você', 'voce', 'vocês', 'voces', 'vc', 'vcs', 'tudo', 'olá', 'ola', 'oi',
      'obrigado', 'obrigada', 'valeu', 'beleza', 'legal', 'opa', 'kkk', 'kkkk', 'kkkkk', 'rsrs',
      'muito', 'muita', 'muitos', 'também', 'tambem', 'tb', 'tbm', 'pq', 'isso', 'isto',
      'aquilo', 'aqui', 'agora', 'hoje', 'amanhã', 'amanha', 'ontem', 'onde', 'quando',
      'porque', 'tenho', 'tem', 'temos', 'têm', 'fazer', 'fazendo', 'pode', 'posso', 'podemos',
      'quero', 'quer', 'queremos', 'ainda', 'então', 'entao', 'sempre', 'nunca', 'nada', 'bom',
      'boa', 'dia', 'tarde', 'noite', 'sim', 'bem', 'menos', 'sem', 'sobre', 'com', 'uma',
      'umas', 'uns', 'esse', 'essa', 'esses', 'essas', 'este', 'esta', 'estes', 'estas', 'dele',
      'dela', 'deles', 'delas', 'nele', 'nela', 'pelo', 'pela', 'pelos', 'pelas', 'dos', 'das',
      'nos', 'nas', 'aos', 'num', 'numa', 'meu', 'minha', 'teu', 'tua', 'seu', 'sua', 'nosso',
      'nossa', 'eles', 'elas', 'nós', 'eu', 'tu', 'ele', 'ela', 'gente', 'cara', 'mano',
      'amigo', 'amigos', 'galera', 'pessoal', 'blz', 'flw', 'falou', 'tchau', 'abraço',
      'desculpa', 'desculpe', 'certo', 'certeza', 'claro', 'vamos', 'bora', 'comer', 'beber',
      'ver', 'falar', 'saber', 'achar', 'acho', 'sei', 'vou', 'vai', 'vão', 'vao', 'era',
      'ser', 'estar', 'sou', 'somos', 'falar', 'trabalhar', 'casa', 'tempo', 'coisa', 'coisas',
      'melhor', 'pior', 'grande', 'pequeno', 'novo', 'nova', 'depois', 'antes', 'logo', 'cedo',
    ]),
    shared: new Set(['que', 'para', 'por', 'como', 'pra', 'pro', 'de', 'do', 'da', 'em', 'no', 'na', 'um', 'os', 'as', 'ao', 'se', 'me', 'te', 'le', 'e', 'ou', 'a', 'o', 'já', 'ja']),
    trigrams: ['ção', 'ões', 'nha', 'lho', 'não', 'ent', 'que', 'est', 'com', 'par', 'dos', 'das', 'ado', 'ido', 'men'],
    suffixes: ['ção', 'ções', 'mente', 'inho', 'inha', 'ando', 'endo', 'indo'],
  },
  Italian: {
    strong: new Set([
      'che', 'non', 'per', 'con', 'una', 'sono', 'sei', 'siamo', 'siete', 'stai', 'ciao',
      'buongiorno', 'buonasera', 'buonanotte', 'grazie', 'prego', 'bene', 'male', 'esatto',
      'perfetto', 'scusa', 'scusi', 'allora', 'quindi', 'anche', 'molto', 'poco', 'tutto',
      'tutti', 'tutte', 'niente', 'nulla', 'sempre', 'mai', 'ora', 'adesso', 'qui', 'qua',
      'oggi', 'domani', 'ieri', 'perché', 'perche', 'come', 'dove', 'quando', 'cosa', 'chi',
      'quale', 'quanto', 'hanno', 'abbiamo', 'avete', 'fare', 'fatto', 'faccio', 'posso',
      'puoi', 'può', 'puo', 'possiamo', 'voglio', 'vuoi', 'vuole', 'vogliamo', 'questo',
      'questa', 'questi', 'queste', 'quello', 'quella', 'quelli', 'quelle', 'degli', 'della',
      'delle', 'dello', 'dalla', 'dalle', 'dallo', 'dagli', 'nella', 'nelle', 'nello', 'negli',
      'alla', 'alle', 'allo', 'agli', 'sulla', 'sulle', 'sullo', 'sugli', 'nel', 'dal', 'sul',
      'col', 'mio', 'mia', 'tuo', 'tua', 'suo', 'sua', 'nostro', 'nostra', 'vostro', 'loro',
      'noi', 'voi', 'lui', 'lei', 'esso', 'essa', 'essi', 'gli', 'così', 'cosi', 'già', 'gia',
      'ancora', 'più', 'piu', 'meno', 'solo', 'soltanto', 'davvero', 'veramente', 'forse',
      'certo', 'ovvio', 'dai', 'allora', 'bello', 'bella', 'buono', 'buona', 'bravo', 'brava',
      'amico', 'amici', 'ragazzi', 'tempo', 'giorno', 'sera', 'notte', 'mattina', 'lavoro',
      'casa', 'mangiare', 'bere', 'vedere', 'parlare', 'sapere', 'pensare', 'penso', 'credo',
      'so', 'vado', 'vai', 'andiamo', 'vieni', 'venire', 'dopo', 'prima', 'subito', 'presto',
    ]),
    shared: new Set(['si', 'sì', 'no', 'va', 'di', 'da', 'in', 'su', 'un', 'il', 'lo', 'la', 'le', 'i', 'e', 'o', 'a', 'ma', 'se', 'mi', 'ti', 'ci', 'vi', 'ne', 'è']),
    trigrams: ['gli', 'zio', 'ell', 'ato', 'ono', 'che', 'per', 'ent', 'ion', 'est', 'lla', 'tto', 'con', 'non', 'sta'],
    suffixes: ['zione', 'zioni', 'mente', 'issimo', 'issima', 'ando', 'endo', 'iamo', 'anno'],
  },
  Dutch: {
    strong: new Set([
      'het', 'een', 'van', 'dat', 'niet', 'met', 'voor', 'zijn', 'maar', 'ook', 'aan', 'nog',
      'wel', 'naar', 'dan', 'wat', 'hoe', 'waar', 'wanneer', 'waarom', 'wie', 'bedankt', 'dank',
      'hallo', 'hoi', 'doei', 'goed', 'heel', 'veel', 'hier', 'jij', 'je', 'wij', 'we', 'zij',
      'ze', 'hij', 'ik', 'jullie', 'hun', 'hebben', 'heeft', 'heb', 'hebt', 'worden', 'wordt',
      'kunnen', 'kan', 'moeten', 'moet', 'willen', 'wil', 'gaan', 'gaat', 'ga', 'doen', 'doet',
      'vandaag', 'morgen', 'gisteren', 'nu', 'straks', 'altijd', 'nooit', 'alles', 'niets',
      'iets', 'gewoon', 'echt', 'leuk', 'mooi', 'lekker', 'prima', 'zeker', 'misschien',
      'eigenlijk', 'natuurlijk', 'sorry', 'alsjeblieft', 'alstublieft', 'graag', 'deze', 'dit',
      'die', 'mijn', 'jouw', 'onze', 'haar', 'hem', 'mij', 'ons', 'uit', 'bij', 'over', 'door',
      'onder', 'tegen', 'zonder', 'tussen', 'omdat', 'want', 'dus', 'toch', 'eens', 'al',
    ]),
    trigrams: ['een', 'van', 'het', 'een', 'ver', 'aar', 'oor', 'ijk', 'sch', 'ing', 'den', 'ten'],
    suffixes: ['lijk', 'heid', 'ing', 'tie', 'eren'],
  },
  Polish: {
    strong: new Set([
      'nie', 'jest', 'się', 'sie', 'jak', 'tak', 'ale', 'czy', 'dla', 'tym', 'tego', 'tylko',
      'bardzo', 'może', 'moze', 'gdzie', 'kiedy', 'dlaczego', 'kto', 'co', 'cześć', 'czesc',
      'hej', 'siema', 'dzięki', 'dzieki', 'dziękuję', 'dziekuje', 'proszę', 'prosze', 'dobrze',
      'tutaj', 'tu', 'teraz', 'dzisiaj', 'dziś', 'jutro', 'wczoraj', 'wszystko', 'nic', 'coś',
      'jeszcze', 'już', 'juz', 'przez', 'które', 'który', 'która', 'ktory', 'ktora', 'jestem',
      'jesteś', 'jesteśmy', 'są', 'mam', 'masz', 'mamy', 'mają', 'mogę', 'możesz', 'chcę',
      'wiem', 'myślę', 'dobry', 'dzień', 'wieczór', 'noc', 'super', 'jasne', 'spoko', 'pewnie',
      'naprawdę', 'zawsze', 'nigdy', 'trochę', 'dużo', 'mało', 'albo', 'lub', 'oraz', 'ponieważ',
    ]),
    trigrams: ['prz', 'nie', 'dzi', 'sze', 'cze', 'jest', 'ego', 'ych', 'ami', 'ość'],
    suffixes: ['ość', 'anie', 'enie', 'ować', 'ski', 'ska'],
  },
  Turkish: {
    strong: new Set([
      'bir', 'bu', 've', 'için', 'icin', 'ile', 'ama', 'fakat', 'çok', 'cok', 'daha', 'gibi',
      'kadar', 'olan', 'olarak', 'var', 'yok', 'ben', 'sen', 'biz', 'siz', 'onlar', 'merhaba',
      'selam', 'teşekkür', 'tesekkur', 'teşekkürler', 'tesekkurler', 'sağol', 'sagol',
      'nasılsın', 'nasilsin', 'nasıl', 'nasil', 'evet', 'hayır', 'hayir', 'şimdi', 'simdi',
      'burada', 'bugün', 'bugun', 'yarın', 'yarin', 'dün', 'her', 'hiç', 'hic', 'şey', 'sey',
      'tamam', 'peki', 'tabii', 'tabi', 'güzel', 'guzel', 'iyi', 'kötü', 'kotu', 'lütfen',
      'lutfen', 'özür', 'ozur', 'pardon', 'nerede', 'neden', 'niye', 'kim', 'ne', 'zaman',
      'değil', 'degil', 'mi', 'mı', 'mu', 'mü', 'benim', 'senin', 'onun', 'bizim', 'sizin',
    ]),
    trigrams: ['lar', 'ler', 'yor', 'bir', 'ini', 'dan', 'den', 'mak', 'mek', 'sin'],
    suffixes: ['iyor', 'ıyor', 'uyor', 'üyor', 'lar', 'ler', 'lik', 'lık'],
  },
  Vietnamese: {
    strong: new Set([
      'không', 'khong', 'của', 'cua', 'và', 'là', 'cho', 'một', 'mot', 'có', 'được', 'duoc',
      'trong', 'này', 'nay', 'những', 'nhung', 'người', 'nguoi', 'với', 'voi', 'bạn', 'ban',
      'tôi', 'toi', 'mình', 'minh', 'chào', 'chao', 'cảm', 'cam', 'ơn', 'rất', 'nhiều', 'nhieu',
      'đang', 'sẽ', 'đã', 'vậy', 'thế', 'sao', 'gì', 'đâu', 'nào', 'khi', 'tại', 'vì', 'nhưng',
      'hoặc', 'cũng', 'rồi', 'chưa', 'luôn', 'lắm', 'quá', 'nhé', 'nha', 'ạ', 'ơi', 'vâng',
      'đúng', 'tốt', 'hôm', 'ngày', 'mai', 'bây', 'giờ', 'làm', 'ăn', 'đi', 'nói', 'biết',
    ]),
    trigrams: ['ông', 'ngư', 'như', 'của', 'đượ', 'tro', 'không'],
  },
  Indonesian: {
    strong: new Set([
      'yang', 'dan', 'ini', 'itu', 'dengan', 'untuk', 'tidak', 'nggak', 'gak', 'dari', 'pada',
      'adalah', 'akan', 'juga', 'bisa', 'ada', 'saya', 'aku', 'kamu', 'anda', 'kita', 'kami',
      'mereka', 'sudah', 'udah', 'belum', 'halo', 'selamat', 'pagi', 'siang', 'sore', 'malam',
      'terima', 'kasih', 'makasih', 'apa', 'kabar', 'baik', 'sangat', 'banget', 'disini',
      'sekarang', 'besok', 'kemarin', 'bagaimana', 'gimana', 'kenapa', 'kapan', 'dimana',
      'siapa', 'atau', 'tapi', 'tetapi', 'karena', 'kalau', 'jika', 'mau', 'ingin', 'harus',
      'boleh', 'semua', 'banyak', 'sedikit', 'baru', 'lama', 'besar', 'kecil', 'ya', 'iya',
    ]),
    trigrams: ['ang', 'kan', 'men', 'ber', 'nya', 'ter', 'dan', 'ada'],
    suffixes: ['kan', 'nya', 'lah', 'kah'],
  },
  Swedish: {
    strong: new Set([
      'och', 'det', 'att', 'som', 'inte', 'för', 'med', 'har', 'jag', 'han', 'hon', 'den',
      'till', 'men', 'var', 'kan', 'ska', 'hej', 'tjena', 'tack', 'bra', 'mycket', 'här', 'nu',
      'idag', 'imorgon', 'hur', 'vad', 'när', 'varför', 'vem', 'också', 'eller', 'från', 'ett',
      'alla', 'bara', 'vill', 'måste', 'skulle', 'kunde', 'blev', 'blir', 'vara', 'göra',
      'tycker', 'tror', 'vet', 'kanske', 'självklart', 'absolut', 'snälla', 'förlåt', 'ja',
      'nej', 'god', 'morgon', 'kväll', 'natt', 'dag', 'tid', 'folk', 'vän', 'vänner', 'hejdå',
    ]),
    trigrams: ['och', 'att', 'för', 'det', 'som', 'ing', 'ter', 'het', 'ska'],
  },
  Czech: {
    strong: new Set([
      'jsou', 'jsem', 'jsi', 'jsme', 'není', 'neni', 'ale', 'pro', 'jako', 'tak', 'byl', 'byla',
      'být', 'byt', 'který', 'ktery', 'která', 'ktera', 'když', 'kdyz', 'velmi', 'ahoj', 'čau',
      'nazdar', 'děkuji', 'dekuji', 'díky', 'diky', 'prosím', 'prosim', 'dobře', 'dobre',
      'tady', 'teď', 'ted', 'dnes', 'zítra', 'kde', 'proč', 'proc', 'kdy', 'kdo', 'co', 'jak',
      'může', 'muze', 'můžu', 'chci', 'vím', 'myslím', 'ano', 'jo', 'ne', 'všechno', 'nic',
      'pořád', 'vždycky', 'nikdy', 'už', 'ještě', 'protože', 'nebo', 'hodně', 'málo', 'jasně',
    ]),
    trigrams: ['pro', 'př', 'ně', 'ení', 'ost', 'ova'],
  },
  Romanian: {
    strong: new Set([
      'este', 'sunt', 'ești', 'suntem', 'care', 'pentru', 'dar', 'mai', 'din', 'sau', 'fost',
      'când', 'cand', 'dacă', 'daca', 'foarte', 'bine', 'bună', 'buna', 'salut', 'pa',
      'mulțumesc', 'multumesc', 'mersi', 'acum', 'aici', 'azi', 'mâine', 'unde', 'cum', 'de',
      'ce', 'cine', 'toate', 'tot', 'nimic', 'acest', 'această', 'aceasta', 'doar', 'poate',
      'vreau', 'pot', 'știu', 'cred', 'da', 'nu', 'te', 'rog', 'scuze', 'sigur', 'mereu',
      'niciodată', 'încă', 'deja', 'mult', 'puțin', 'frumos', 'bun', 'ziua', 'seara', 'noapte',
    ]),
    trigrams: ['are', 'ent', 'ion', 'eat', 'ului', 'esc'],
  },
  Danish: {
    strong: new Set([
      'og', 'det', 'er', 'ikke', 'jeg', 'du', 'vi', 'de', 'han', 'hun', 'til', 'med', 'på',
      'for', 'af', 'som', 'men', 'har', 'kan', 'skal', 'vil', 'hej', 'tak', 'godt', 'meget',
      'her', 'nu', 'hvordan', 'hvad', 'hvor', 'hvornår', 'hvorfor', 'hvem', 'også', 'eller',
      'fra', 'alle', 'bare', 'måske', 'selvfølgelig', 'undskyld', 'ja', 'nej', 'idag', 'imorgen',
    ]),
  },
  Norwegian: {
    strong: new Set([
      'og', 'det', 'er', 'ikke', 'jeg', 'du', 'vi', 'de', 'han', 'hun', 'til', 'med', 'på',
      'for', 'av', 'som', 'men', 'har', 'kan', 'skal', 'vil', 'hei', 'takk', 'bra', 'veldig',
      'mye', 'her', 'nå', 'hvordan', 'hva', 'hvor', 'når', 'hvorfor', 'hvem', 'også', 'eller',
      'fra', 'alle', 'bare', 'kanskje', 'selvfølgelig', 'unnskyld', 'ja', 'nei', 'idag',
    ]),
  },
  Finnish: {
    strong: new Set([
      'ja', 'on', 'ei', 'että', 'se', 'hän', 'minä', 'sinä', 'me', 'te', 'he', 'oli', 'ovat',
      'mutta', 'tai', 'kun', 'jos', 'niin', 'kuin', 'vain', 'myös', 'vielä', 'jo', 'nyt',
      'täällä', 'tänään', 'huomenna', 'hei', 'moi', 'terve', 'kiitos', 'ole', 'hyvä', 'kyllä',
      'joo', 'mitä', 'missä', 'milloin', 'miksi', 'kuka', 'kuinka', 'paljon', 'kaikki', 'anteeksi',
    ]),
  },
  Hungarian: {
    strong: new Set([
      'és', 'az', 'egy', 'nem', 'igen', 'van', 'vagy', 'volt', 'lesz', 'hogy', 'mert', 'mint',
      'csak', 'már', 'még', 'most', 'itt', 'ott', 'ma', 'holnap', 'szia', 'helló', 'köszönöm',
      'köszi', 'kérem', 'jó', 'nagyon', 'mi', 'ki', 'hol', 'mikor', 'miért', 'hogyan', 'minden',
      'semmi', 'talán', 'persze', 'bocsánat', 'nekem', 'neked', 'velem', 'veled', 'szerintem',
    ]),
  },
  Catalan: {
    strong: new Set([
      'els', 'les', 'amb', 'però', 'pero', 'això', 'aixo', 'aquest', 'aquesta', 'molt', 'molta',
      'també', 'tambe', 'sempre', 'mai', 'ara', 'aquí', 'avui', 'demà', 'ahir', 'bon', 'dia',
      'bona', 'tarda', 'nit', 'gràcies', 'gracies', 'merci', 'adeu', 'adéu', 'hola', 'com',
      'estàs', 'està', 'estic', 'som', 'són', 'tinc', 'tens', 'tenim', 'vull', 'puc', 'pots',
      'fer', 'perquè', 'perque', 'quan', 'on', 'qui', 'què', 'res', 'tot', 'tots', 'sí', 'no',
    ]),
  },
  Croatian: {
    strong: new Set([
      'je', 'su', 'sam', 'si', 'smo', 'ste', 'nije', 'nisam', 'ali', 'ili', 'ako', 'kad',
      'kada', 'gdje', 'zašto', 'zasto', 'kako', 'tko', 'što', 'sto', 'ovdje', 'tu', 'sada',
      'sad', 'danas', 'sutra', 'jučer', 'bok', 'pozdrav', 'ćao', 'hvala', 'molim', 'dobro',
      'super', 'odlično', 'uvijek', 'nikad', 'sve', 'ništa', 'nešto', 'puno', 'malo', 'možda',
      'naravno', 'oprosti', 'izvini', 'da', 'ne', 'mogu', 'može', 'želim', 'znam', 'mislim',
    ]),
  },
  Slovak: {
    strong: new Set([
      'som', 'si', 'sme', 'ste', 'sú', 'nie', 'ale', 'pre', 'ako', 'tak', 'bol', 'bola', 'byť',
      'ktorý', 'ktorá', 'ktoré', 'keď', 'veľmi', 'ahoj', 'čau', 'ďakujem', 'vďaka', 'prosím',
      'dobre', 'tu', 'teraz', 'dnes', 'zajtra', 'kde', 'prečo', 'kedy', 'kto', 'čo', 'môže',
      'môžem', 'chcem', 'viem', 'myslím', 'áno', 'všetko', 'nič', 'stále', 'vždy', 'nikdy',
      'už', 'ešte', 'pretože', 'alebo', 'veľa', 'málo', 'jasné',
    ]),
  },
  Tagalog: {
    strong: new Set([
      'ang', 'ng', 'sa', 'na', 'ay', 'ko', 'mo', 'ka', 'siya', 'kami', 'tayo', 'kayo', 'sila',
      'ako', 'ikaw', 'ito', 'iyan', 'iyon', 'dito', 'doon', 'ngayon', 'bukas', 'kahapon',
      'kumusta', 'kamusta', 'salamat', 'po', 'opo', 'oo', 'hindi', 'wala', 'meron', 'may',
      'pero', 'kasi', 'dahil', 'kung', 'kapag', 'ano', 'sino', 'saan', 'kailan', 'bakit',
      'paano', 'gusto', 'pwede', 'puwede', 'maganda', 'mabuti', 'lahat', 'sobra', 'talaga',
    ]),
  },
}

const SCRIPT_CHECKS: ReadonlyArray<{
  re: RegExp
  resolve: (sample: string) => string
}> = [
  { re: /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF]/g, resolve: () => 'Japanese' },
  { re: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g, resolve: () => 'Korean' },
  {
    re: /[\u4E00-\u9FFF]/g,
    resolve: (sample) => {
      const tradMatches = sample.match(TRADITIONAL_HAN_RE)?.length ?? 0
      const simpMatches = sample.match(SIMPLIFIED_HAN_RE)?.length ?? 0
      return tradMatches > simpMatches ? 'Chinese (Traditional)' : 'Chinese (Simplified)'
    },
  },
  {
    re: /[\u0400-\u04FF]/g,
    resolve: (sample) => {
      if (/[іїєґІЇЄҐ]/.test(sample)) return 'Ukrainian'
      if (/[ђјљњћџЂЈЉЊЋЏ]/.test(sample)) return 'Serbian'
      if (/[ъЪ]/.test(sample)) {
        const words = sample.toLowerCase().match(/[\u0400-\u04FF]+/g) ?? []
        let bgHits = 0
        for (const w of words) {
          if (BULGARIAN_WORDS.has(w)) bgHits += 1
        }
        if (bgHits >= 1) return 'Bulgarian'
      }
      return 'Russian'
    },
  },
  {
    re: /[\u0600-\u06FF\u0750-\u077F]/g,
    resolve: (sample) => {
      if (/[ٹڈڑںےہھ]/.test(sample)) return 'Urdu'
      if (/[پچژگکی]/.test(sample)) return 'Persian'
      return 'Arabic'
    },
  },
  { re: /[\u0900-\u097F]/g, resolve: () => 'Hindi' },
  { re: /[\u0980-\u09FF]/g, resolve: () => 'Bengali' },
  { re: /[\u0B80-\u0BFF]/g, resolve: () => 'Tamil' },
  { re: /[\u0E00-\u0E7F]/g, resolve: () => 'Thai' },
  { re: /[\u0370-\u03FF]/g, resolve: () => 'Greek' },
  { re: /[\u0590-\u05FF]/g, resolve: () => 'Hebrew' },
]

/**
 * Detects the language of a single chat message with explicit confidence.
 * NEVER fabricates `'English'` when signal is absent — returns `{ lang: null, confidence: 'low', score: 0 }`.
 */
export function detectLanguageDetailed(text: string): LanguageDetectionResult {
  const sample = stripNonProseForDetection(text).trim()
  if (!sample) {
    return { lang: null, confidence: 'low', score: 0 }
  }

  const allLetters = sample.match(/\p{L}/gu)
  const totalLetters = allLetters?.length ?? 0
  if (totalLetters === 0) {
    return { lang: null, confidence: 'low', score: 0 }
  }

  // Tier 1: Deterministic Unicode script detection
  for (const check of SCRIPT_CHECKS) {
    const matches = sample.match(check.re)
    if (!matches || matches.length === 0) continue
    // Avoid false-triggering on a single Greek math symbol (e.g. "α") inside a long Latin sentence
    if (matches.length >= 2 || matches.length / totalLetters >= 0.3) {
      return {
        lang: check.resolve(sample),
        confidence: 'high',
        score: 10 + Math.min(10, matches.length),
      }
    }
  }

  // Tier 2: Latin diacritics, weighted lexicons, character trigrams, and suffixes
  const scores: Record<string, number> = {}
  const addScore = (lang: string, pts: number) => {
    scores[lang] = (scores[lang] ?? 0) + pts
  }

  // Distinctive diacritics & punctuation
  if (/[¿¡ñÑ]/.test(sample)) addScore('Spanish', 5.5)
  if (/[ãõÃÕ]/.test(sample)) addScore('Portuguese', 6)
  if (/[ß]/.test(sample)) addScore('German', 6)
  if (/[üÜ]/.test(sample)) {
    addScore('German', 2.5)
    addScore('Turkish', 1.2)
    addScore('Hungarian', 1.2)
  }
  if (/[äöÄÖ]/.test(sample)) {
    addScore('German', 1.8)
    addScore('Swedish', 1.6)
    addScore('Finnish', 1.6)
  }
  if (/[åÅ]/.test(sample)) {
    addScore('Swedish', 4.5)
    addScore('Danish', 2.5)
    addScore('Norwegian', 2.5)
  }
  if (/[æøÆØ]/.test(sample)) {
    addScore('Danish', 4)
    addScore('Norwegian', 4)
  }
  if (/[őűŐŰ]/.test(sample)) addScore('Hungarian', 6.5)
  if (/[łśźżćńąęŁŚŹŻĆŃĄĘ]/.test(sample)) addScore('Polish', 6)
  if (/[ğışİĞŞ]/.test(sample)) addScore('Turkish', 6)
  if (/[đĐơƠưƯạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/.test(sample)) {
    addScore('Vietnamese', 7)
  }
  if (/[řěůŘĚŮ]/.test(sample)) addScore('Czech', 6)
  if (/[ľĺŕôĽĹŔÔ]/.test(sample)) addScore('Slovak', 5)
  if (/[čšžďťňČŠŽĎŤŇ]/.test(sample)) {
    addScore('Czech', 2)
    addScore('Slovak', 1.8)
    addScore('Croatian', 1.6)
  }
  if (/[șțȘȚăĂ]/.test(sample)) addScore('Romanian', 6)
  if (/[œŒ]/.test(sample)) addScore('French', 5.5)
  if (/[àèùÀÈÙ]/.test(sample)) {
    addScore('French', 2.6)
    addScore('Italian', 1.6)
    addScore('Catalan', 1.4)
  }
  if (/[çÇ]/.test(sample)) {
    addScore('French', 1.8)
    addScore('Portuguese', 1.6)
    addScore('Turkish', 1.5)
    addScore('Catalan', 1.5)
  }
  if (/[êîûÊÎÛ]/.test(sample)) {
    addScore('French', 2.2)
    addScore('Portuguese', 1.2)
    addScore('Romanian', 1.2)
  }
  if (/[áéíóúÁÉÍÓÚ]/.test(sample)) {
    addScore('Spanish', 1.1)
    addScore('Portuguese', 0.8)
    addScore('Hungarian', 0.6)
    addScore('Czech', 0.5)
  }
  if (/l·l/i.test(sample)) addScore('Catalan', 5.5)

  // Tokenize Latin words (preserving contractions like don't / c'est / d'accord)
  const words = sample.toLowerCase().match(/[\p{L}]+(?:['’][\p{L}]+)?/gu) ?? []
  for (const rawWord of words) {
    const word = rawWord.replace(/’/g, "'")
    for (const [lang, profile] of Object.entries(LATIN_PROFILES)) {
      if (profile.strong.has(word)) {
        addScore(lang, 2.5)
      } else if (profile.shared?.has(word)) {
        addScore(lang, 0.9)
      }
      if (profile.suffixes && word.length >= 5) {
        for (const suf of profile.suffixes) {
          if (word.endsWith(suf)) {
            addScore(lang, 0.7)
            break
          }
        }
      }
    }
  }

  // Character trigram profile for medium/longer sentences (disambiguates prose with few stopwords)
  if (totalLetters >= 8) {
    const lowerSample = sample.toLowerCase()
    for (const [lang, profile] of Object.entries(LATIN_PROFILES)) {
      if (!profile.trigrams) continue
      let trigramHits = 0
      for (const tri of profile.trigrams) {
        if (lowerSample.includes(tri)) {
          trigramHits += 1
          if (trigramHits >= 5) break
        }
      }
      if (trigramHits > 0) {
        addScore(lang, trigramHits * 0.45)
      }
    }
  }

  let bestLang: string | null = null
  let bestScore = 0
  let secondScore = 0

  for (const [lang, sc] of Object.entries(scores)) {
    if (sc > bestScore) {
      secondScore = bestScore
      bestScore = sc
      bestLang = lang
    } else if (sc > secondScore) {
      secondScore = sc
    }
  }

  if (!bestLang || bestScore <= 0) {
    return { lang: null, confidence: 'low', score: 0 }
  }

  const roundedScore = Math.round(bestScore * 100) / 100
  if (bestScore >= 4 && bestScore >= secondScore * 1.4) {
    return { lang: bestLang, confidence: 'high', score: roundedScore }
  }
  if (bestScore >= 2 && bestScore > secondScore) {
    return { lang: bestLang, confidence: 'medium', score: roundedScore }
  }
  return { lang: bestLang, confidence: 'low', score: roundedScore }
}

/**
 * Scans up to the latest 40 messages in a room to infer its dominant foreign
 * language (excluding the reader's own language). Used to accurately translate
 * short ambiguous replies (e.g. `"ok"`, `"dale"`, `"si"`, `"claro"`) when the
 * room is predominantly speaking Spanish, French, Japanese, etc.
 */
export function detectRoomDominantLanguage(
  texts: readonly string[],
  excludeLang?: string | null
): string | null {
  if (!texts || texts.length === 0) return null
  const excludeNorm = excludeLang?.trim().toLowerCase() ?? ''
  const start = Math.max(0, texts.length - 40)
  const weights = new Map<string, number>()

  for (let i = start; i < texts.length; i += 1) {
    const raw = texts[i]
    if (!raw || isNonTranslatableText(raw)) continue
    const detected = detectLanguageDetailed(raw)
    if (!detected.lang || detected.confidence === 'low') continue
    if (excludeNorm && detected.lang.toLowerCase() === excludeNorm) continue
    const w = detected.confidence === 'high' ? 2 : 1
    weights.set(detected.lang, (weights.get(detected.lang) ?? 0) + w)
  }

  let topLang: string | null = null
  let topWeight = 0
  let secondWeight = 0
  for (const [lang, w] of weights.entries()) {
    if (w > topWeight) {
      secondWeight = topWeight
      topWeight = w
      topLang = lang
    } else if (w > secondWeight) {
      secondWeight = w
    }
  }

  if (!topLang || topWeight < 2) return null
  if (topWeight === secondWeight) return null
  return topLang
}
