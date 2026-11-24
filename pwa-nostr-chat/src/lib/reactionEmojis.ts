import { useSyncExternalStore } from 'react'

export const PINNED_REACTIONS_STORAGE_KEY = 'agnostr:v2:pinned_reactions'
export const DEFAULT_PINNED_REACTIONS = ['👍', '❤️', '🔥', '😂', '👀', '⚡'] as const
export const MAX_PINNED_REACTIONS = 9

export type ReactionEmojiCategoryId =
  | 'smileys'
  | 'gestures'
  | 'hearts'
  | 'objects'
  | 'nature'
  | 'food'
  | 'symbols'

export interface ReactionEmojiEntry {
  readonly emoji: string
  readonly name: string
  readonly category: ReactionEmojiCategoryId
  readonly keywords: readonly string[]
}

export const REACTION_EMOJI_CATEGORIES: readonly {
  readonly id: ReactionEmojiCategoryId
  readonly label: string
  readonly icon: string
}[] = [
  { id: 'smileys', label: 'Smileys', icon: '😀' },
  { id: 'gestures', label: 'Gestures', icon: '👍' },
  { id: 'hearts', label: 'Hearts', icon: '❤️' },
  { id: 'objects', label: 'Objects', icon: '🚀' },
  { id: 'nature', label: 'Nature', icon: '🔥' },
  { id: 'food', label: 'Food', icon: '☕' },
  { id: 'symbols', label: 'Symbols', icon: '💯' },
]

export const REACTION_EMOJI_CATALOG: readonly ReactionEmojiEntry[] = [
  // ================= SMILEYS =================
  { emoji: '😂', name: 'Tears of Joy', category: 'smileys', keywords: ['laugh', 'lol', 'funny', 'haha'] },
  { emoji: '🤣', name: 'Rolling Laughing', category: 'smileys', keywords: ['rofl', 'lmao', 'hilarious'] },
  { emoji: '😀', name: 'Grinning Face', category: 'smileys', keywords: ['smile', 'happy', 'glad'] },
  { emoji: '😊', name: 'Smiling Eyes', category: 'smileys', keywords: ['blush', 'warm', 'nice', 'wholesome'] },
  { emoji: '😁', name: 'Beaming Face', category: 'smileys', keywords: ['grin', 'excited', 'yay'] },
  { emoji: '🙂', name: 'Slightly Smiling', category: 'smileys', keywords: ['ok', 'fine', 'polite'] },
  { emoji: '😉', name: 'Winking Face', category: 'smileys', keywords: ['wink', 'flirt', 'joke', 'hint'] },
  { emoji: '😍', name: 'Heart Eyes', category: 'smileys', keywords: ['love', 'adore', 'amazing'] },
  { emoji: '🥰', name: 'Smiling with Hearts', category: 'smileys', keywords: ['love', 'aww', 'sweet'] },
  { emoji: '🤩', name: 'Star-Struck', category: 'smileys', keywords: ['wow', 'awesome', 'impressed'] },
  { emoji: '😎', name: 'Cool Sunglasses', category: 'smileys', keywords: ['cool', 'smooth', 'chill', 'based'] },
  { emoji: '🥳', name: 'Partying Face', category: 'smileys', keywords: ['celebrate', 'party', 'congrats', 'birthday'] },
  { emoji: '😏', name: 'Smirking Face', category: 'smileys', keywords: ['smug', 'sly', 'heh'] },
  { emoji: '🤔', name: 'Thinking Face', category: 'smileys', keywords: ['hmm', 'wonder', 'curious', 'think'] },
  { emoji: '🤨', name: 'Raised Eyebrow', category: 'smileys', keywords: ['skeptical', 'sus', 'doubt'] },
  { emoji: '🧐', name: 'Monocle Face', category: 'smileys', keywords: ['inspect', 'curious', 'fancy', 'audit'] },
  { emoji: '😮', name: 'Open Mouth', category: 'smileys', keywords: ['surprised', 'whoa', 'oh'] },
  { emoji: '😲', name: 'Astonished Face', category: 'smileys', keywords: ['shocked', 'gasp', 'amazed'] },
  { emoji: '🤯', name: 'Exploding Head', category: 'smileys', keywords: ['mindblown', 'whoa', 'crazy', 'insane'] },
  { emoji: '😳', name: 'Flushed Face', category: 'smileys', keywords: ['embarrassed', 'shy', 'awkward'] },
  { emoji: '🥺', name: 'Pleading Face', category: 'smileys', keywords: ['please', 'cute', 'puppy'] },
  { emoji: '🥹', name: 'Holding Back Tears', category: 'smileys', keywords: ['touched', 'proud', 'emotional'] },
  { emoji: '😢', name: 'Crying Face', category: 'smileys', keywords: ['sad', 'tear', 'sorry'] },
  { emoji: '😭', name: 'Loudly Crying', category: 'smileys', keywords: ['sob', 'bawl', 'hilarious', 'sad'] },
  { emoji: '😤', name: 'Triumph Steam', category: 'smileys', keywords: ['huff', 'determined', 'frustrated'] },
  { emoji: '😡', name: 'Pouting Face', category: 'smileys', keywords: ['angry', 'mad', 'rage'] },
  { emoji: '🤬', name: 'Swearing Face', category: 'smileys', keywords: ['furious', 'curse', 'angry'] },
  { emoji: '😱', name: 'Screaming Fear', category: 'smileys', keywords: ['omg', 'scared', 'panic'] },
  { emoji: '😅', name: 'Grinning Sweat', category: 'smileys', keywords: ['phew', 'relief', 'nervous', 'close'] },
  { emoji: '😬', name: 'Grimacing Face', category: 'smileys', keywords: ['yikes', 'cringe', 'oof', 'awkward'] },
  { emoji: '🫠', name: 'Melting Face', category: 'smileys', keywords: ['melt', 'awkward', 'exhausted', 'heat'] },
  { emoji: '🙃', name: 'Upside-Down Face', category: 'smileys', keywords: ['sarcasm', 'silly', 'ironic'] },
  { emoji: '😴', name: 'Sleeping Face', category: 'smileys', keywords: ['sleep', 'tired', 'zzz', 'boring'] },
  { emoji: '🥱', name: 'Yawning Face', category: 'smileys', keywords: ['sleepy', 'tired', 'yawn'] },
  { emoji: '🤢', name: 'Nauseated Face', category: 'smileys', keywords: ['sick', 'gross', 'yuck'] },
  { emoji: '🤮', name: 'Vomiting Face', category: 'smileys', keywords: ['puke', 'disgusting', 'gross'] },
  { emoji: '🤧', name: 'Sneezing Face', category: 'smileys', keywords: ['sick', 'cold', 'achoo'] },
  { emoji: '🤒', name: 'Thermometer Face', category: 'smileys', keywords: ['ill', 'fever', 'sick'] },
  { emoji: '🤓', name: 'Nerd Face', category: 'smileys', keywords: ['geek', 'smart', 'ackchyually', 'code'] },
  { emoji: '🤠', name: 'Cowboy Hat', category: 'smileys', keywords: ['yeehaw', 'western', 'howdy'] },
  { emoji: '🥸', name: 'Disguised Face', category: 'smileys', keywords: ['incognito', 'anon', 'privacy', 'spy'] },
  { emoji: '🤫', name: 'Shushing Face', category: 'smileys', keywords: ['quiet', 'secret', 'shh'] },
  { emoji: '🤭', name: 'Hand Over Mouth', category: 'smileys', keywords: ['oops', 'giggle', 'teehee'] },
  { emoji: '🫣', name: 'Peeking Eye', category: 'smileys', keywords: ['peek', 'nervous', 'shy', 'scary'] },
  { emoji: '🫢', name: 'Open Eyes Hand Over Mouth', category: 'smileys', keywords: ['gasp', 'oops', 'surprise'] },
  { emoji: '🫡', name: 'Saluting Face', category: 'smileys', keywords: ['salute', 'respect', 'roger', 'aye', 'o7'] },
  { emoji: '🫥', name: 'Dotted Line Face', category: 'smileys', keywords: ['invisible', 'lurk', 'vanish'] },
  { emoji: '😐', name: 'Neutral Face', category: 'smileys', keywords: ['meh', 'deadpan', 'blank'] },
  { emoji: '😑', name: 'Expressionless Face', category: 'smileys', keywords: ['bruh', 'unimpressed', 'flat'] },
  { emoji: '🙄', name: 'Rolling Eyes', category: 'smileys', keywords: ['whatever', 'sigh', 'annoyed'] },
  { emoji: '😒', name: 'Unamused Face', category: 'smileys', keywords: ['side-eye', 'meh', 'doubt'] },
  { emoji: '😈', name: 'Smiling Imp', category: 'smileys', keywords: ['devil', 'mischief', 'evil'] },
  { emoji: '🤡', name: 'Clown Face', category: 'smileys', keywords: ['clown', 'fool', 'joker', 'meme'] },
  { emoji: '💀', name: 'Skull', category: 'smileys', keywords: ['dead', 'dying', 'rip', 'lol'] },
  { emoji: '👻', name: 'Ghost', category: 'smileys', keywords: ['boo', 'spooky', 'ghosted'] },
  { emoji: '👽', name: 'Alien', category: 'smileys', keywords: ['ufo', 'space', 'extraterrestrial'] },
  { emoji: '🤖', name: 'Robot', category: 'smileys', keywords: ['bot', 'ai', 'cyborg', 'tech'] },
  { emoji: '💩', name: 'Pile of Poo', category: 'smileys', keywords: ['poop', 'crap', 'junk'] },

  // ================= GESTURES =================
  { emoji: '👍', name: 'Thumbs Up', category: 'gestures', keywords: ['yes', 'agree', 'like', 'good', 'ok'] },
  { emoji: '👎', name: 'Thumbs Down', category: 'gestures', keywords: ['no', 'disagree', 'dislike', 'bad'] },
  { emoji: '👀', name: 'Eyes', category: 'gestures', keywords: ['look', 'watching', 'see', 'interesting'] },
  { emoji: '🙌', name: 'Raising Hands', category: 'gestures', keywords: ['hooray', 'praise', 'celebrate', 'woot'] },
  { emoji: '👏', name: 'Clapping Hands', category: 'gestures', keywords: ['applause', 'bravo', 'congrats'] },
  { emoji: '🙏', name: 'Folded Hands', category: 'gestures', keywords: ['please', 'thanks', 'thank you', 'pray', 'namaste'] },
  { emoji: '🤝', name: 'Handshake', category: 'gestures', keywords: ['deal', 'agree', 'partner', 'trust'] },
  { emoji: '🤙', name: 'Call Me Hand', category: 'gestures', keywords: ['shaka', 'nostr', 'hang loose', 'chill'] },
  { emoji: '✌️', name: 'Victory Hand', category: 'gestures', keywords: ['peace', 'two', 'win'] },
  { emoji: '🤞', name: 'Crossed Fingers', category: 'gestures', keywords: ['luck', 'hope', 'wish'] },
  { emoji: '🤟', name: 'Love-You Gesture', category: 'gestures', keywords: ['ily', 'rock', 'love'] },
  { emoji: '🤘', name: 'Sign of the Horns', category: 'gestures', keywords: ['rock', 'metal', 'party'] },
  { emoji: '👌', name: 'OK Hand', category: 'gestures', keywords: ['perfect', 'nice', 'chef kiss', 'ok'] },
  { emoji: '🤌', name: 'Pinched Fingers', category: 'gestures', keywords: ['italian', 'chef kiss', 'perfection'] },
  { emoji: '🫶', name: 'Heart Hands', category: 'gestures', keywords: ['love', 'appreciate', 'support'] },
  { emoji: '💪', name: 'Flexed Biceps', category: 'gestures', keywords: ['strong', 'power', 'workout', 'gm'] },
  { emoji: '👋', name: 'Waving Hand', category: 'gestures', keywords: ['hello', 'hi', 'bye', 'gm', 'welcome'] },
  { emoji: '👊', name: 'Oncoming Fist', category: 'gestures', keywords: ['fist bump', 'bro', 'punch'] },
  { emoji: '✊', name: 'Raised Fist', category: 'gestures', keywords: ['solidarity', 'power', 'freedom'] },
  { emoji: '☝️', name: 'Index Pointing Up', category: 'gestures', keywords: ['this', 'point', 'one', 'up'] },
  { emoji: '👆', name: 'Backhand Pointing Up', category: 'gestures', keywords: ['this', 'above', 'up'] },
  { emoji: '👇', name: 'Backhand Pointing Down', category: 'gestures', keywords: ['below', 'down', 'here'] },
  { emoji: '👉', name: 'Pointing Right', category: 'gestures', keywords: ['right', 'this', 'next'] },
  { emoji: '👈', name: 'Pointing Left', category: 'gestures', keywords: ['left', 'back', 'that'] },
  { emoji: '🫵', name: 'Index Pointing at Viewer', category: 'gestures', keywords: ['you', 'point'] },
  { emoji: '🤷', name: 'Person Shrugging', category: 'gestures', keywords: ['shrug', 'idk', 'dunno', 'whatever'] },
  { emoji: '🤦', name: 'Person Facepalming', category: 'gestures', keywords: ['facepalm', 'doh', 'smh'] },
  { emoji: '🙆', name: 'Person Gesturing OK', category: 'gestures', keywords: ['yes', 'ok', 'approve'] },
  { emoji: '🙅', name: 'Person Gesturing No', category: 'gestures', keywords: ['no', 'nope', 'stop'] },
  { emoji: '🧠', name: 'Brain', category: 'gestures', keywords: ['smart', 'big brain', 'idea', 'genius'] },
  { emoji: '🫂', name: 'People Hugging', category: 'gestures', keywords: ['hug', 'comfort', 'support', 'embrace'] },

  // ================= HEARTS =================
  { emoji: '❤️', name: 'Red Heart', category: 'hearts', keywords: ['love', 'like', 'heart'] },
  { emoji: '🧡', name: 'Orange Heart', category: 'hearts', keywords: ['bitcoin', 'orange', 'love', 'warm'] },
  { emoji: '💛', name: 'Yellow Heart', category: 'hearts', keywords: ['gold', 'friendship', 'happy'] },
  { emoji: '💚', name: 'Green Heart', category: 'hearts', keywords: ['green', 'eco', 'good'] },
  { emoji: '💙', name: 'Blue Heart', category: 'hearts', keywords: ['blue', 'trust', 'calm'] },
  { emoji: '💜', name: 'Purple Heart', category: 'hearts', keywords: ['nostr', 'purple', 'love'] },
  { emoji: '🖤', name: 'Black Heart', category: 'hearts', keywords: ['dark', 'goth', 'minimal'] },
  { emoji: '🤍', name: 'White Heart', category: 'hearts', keywords: ['pure', 'clean', 'love'] },
  { emoji: '🩷', name: 'Pink Heart', category: 'hearts', keywords: ['cute', 'sweet', 'pink'] },
  { emoji: '🩵', name: 'Light Blue Heart', category: 'hearts', keywords: ['cyan', 'sky', 'chill'] },
  { emoji: '💔', name: 'Broken Heart', category: 'hearts', keywords: ['sad', 'heartbreak', 'ouch'] },
  { emoji: '❤️‍🔥', name: 'Heart on Fire', category: 'hearts', keywords: ['passion', 'lit', 'love', 'fire'] },
  { emoji: '💖', name: 'Sparkling Heart', category: 'hearts', keywords: ['sparkle', 'love', 'shiny'] },
  { emoji: '💘', name: 'Heart with Arrow', category: 'hearts', keywords: ['cupid', 'crush', 'love'] },
  { emoji: '💝', name: 'Heart with Ribbon', category: 'hearts', keywords: ['gift', 'love', 'present'] },
  { emoji: '💞', name: 'Revolving Hearts', category: 'hearts', keywords: ['love', 'cute', 'vibes'] },
  { emoji: '💋', name: 'Kiss Mark', category: 'hearts', keywords: ['kiss', 'muah', 'love'] },

  // ================= OBJECTS =================
  { emoji: '🚀', name: 'Rocket', category: 'objects', keywords: ['launch', 'moon', 'ship', 'fast', 'pump'] },
  { emoji: '🎉', name: 'Party Popper', category: 'objects', keywords: ['celebrate', 'congrats', 'tada', 'launch'] },
  { emoji: '🎊', name: 'Confetti Ball', category: 'objects', keywords: ['party', 'celebration', 'festive'] },
  { emoji: '🏆', name: 'Trophy', category: 'objects', keywords: ['win', 'winner', 'champ', 'award', 'first'] },
  { emoji: '🥇', name: 'First Place Medal', category: 'objects', keywords: ['gold', 'winner', 'number one'] },
  { emoji: '🎯', name: 'Bullseye', category: 'objects', keywords: ['target', 'accurate', 'spot on', 'direct', 'bingo'] },
  { emoji: '💎', name: 'Gem Stone', category: 'objects', keywords: ['diamond', 'rare', 'gem', 'hodl', 'valuable'] },
  { emoji: '👑', name: 'Crown', category: 'objects', keywords: ['king', 'queen', 'royalty', 'boss', 'legend'] },
  { emoji: '🔑', name: 'Key', category: 'objects', keywords: ['keys', 'crypto', 'nostr', 'unlock', 'security'] },
  { emoji: '🔒', name: 'Locked', category: 'objects', keywords: ['private', 'encrypted', 'secure', 'lock'] },
  { emoji: '🛡️', name: 'Shield', category: 'objects', keywords: ['protect', 'defense', 'safe', 'security'] },
  { emoji: '💡', name: 'Light Bulb', category: 'objects', keywords: ['idea', 'smart', 'tip', 'eureka'] },
  { emoji: '🔔', name: 'Bell', category: 'objects', keywords: ['alert', 'notify', 'ring', 'ping'] },
  { emoji: '📌', name: 'Pushpin', category: 'objects', keywords: ['pin', 'save', 'important', 'bookmark'] },
  { emoji: '📎', name: 'Paperclip', category: 'objects', keywords: ['attach', 'link', 'file'] },
  { emoji: '📝', name: 'Memo', category: 'objects', keywords: ['note', 'write', 'log', 'draft'] },
  { emoji: '📚', name: 'Books', category: 'objects', keywords: ['read', 'learn', 'study', 'knowledge'] },
  { emoji: '💻', name: 'Laptop', category: 'objects', keywords: ['code', 'dev', 'work', 'computer'] },
  { emoji: '📱', name: 'Mobile Phone', category: 'objects', keywords: ['phone', 'pwa', 'app', 'mobile'] },
  { emoji: '🛰️', name: 'Satellite', category: 'objects', keywords: ['relay', 'mesh', 'space', 'signal'] },
  { emoji: '📡', name: 'Satellite Antenna', category: 'objects', keywords: ['broadcast', 'relay', 'signal', 'mesh'] },
  { emoji: '🎧', name: 'Headphone', category: 'objects', keywords: ['music', 'audio', 'listen', 'voice'] },
  { emoji: '🎤', name: 'Microphone', category: 'objects', keywords: ['voice', 'speak', 'mic', 'podcast'] },
  { emoji: '🎬', name: 'Clapper Board', category: 'objects', keywords: ['movie', 'film', 'video', 'action'] },
  { emoji: '📸', name: 'Camera with Flash', category: 'objects', keywords: ['photo', 'snap', 'pic', 'caught'] },
  { emoji: '🎮', name: 'Video Game', category: 'objects', keywords: ['gaming', 'play', 'controller', 'gg'] },
  { emoji: '🎲', name: 'Game Die', category: 'objects', keywords: ['dice', 'random', 'roll', 'luck'] },
  { emoji: '🧩', name: 'Puzzle Piece', category: 'objects', keywords: ['fit', 'solve', 'piece', 'module'] },
  { emoji: '🔧', name: 'Wrench', category: 'objects', keywords: ['fix', 'tool', 'repair', 'build'] },
  { emoji: '🔨', name: 'Hammer', category: 'objects', keywords: ['build', 'ban', 'tool', 'ship'] },
  { emoji: '⚙️', name: 'Gear', category: 'objects', keywords: ['settings', 'config', 'engine', 'system'] },
  { emoji: '🧪', name: 'Test Tube', category: 'objects', keywords: ['experiment', 'lab', 'beta', 'test'] },
  { emoji: '💰', name: 'Money Bag', category: 'objects', keywords: ['sats', 'cash', 'rich', 'wealth', 'ecash'] },
  { emoji: '💸', name: 'Money with Wings', category: 'objects', keywords: ['spend', 'zap', 'paid', 'expensive'] },
  { emoji: '🪙', name: 'Coin', category: 'objects', keywords: ['bitcoin', 'sats', 'token', 'ecash', 'mint'] },
  { emoji: '🎁', name: 'Wrapped Gift', category: 'objects', keywords: ['present', 'surprise', 'gift', 'bonus'] },
  { emoji: '🎈', name: 'Balloon', category: 'objects', keywords: ['party', 'fun', 'celebrate'] },
  { emoji: '💣', name: 'Bomb', category: 'objects', keywords: ['boom', 'explosive', 'drop'] },
  { emoji: '🧭', name: 'Compass', category: 'objects', keywords: ['map', 'explore', 'navigate', 'geo'] },
  { emoji: '🗺️', name: 'World Map', category: 'objects', keywords: ['map', 'location', 'travel', 'geohash'] },
  { emoji: '⏰', name: 'Alarm Clock', category: 'objects', keywords: ['time', 'wake', 'soon', 'deadline'] },
  { emoji: '⏳', name: 'Hourglass', category: 'objects', keywords: ['wait', 'loading', 'patience', 'time'] },
  { emoji: '🗑️', name: 'Wastebasket', category: 'objects', keywords: ['trash', 'delete', 'garbage'] },

  // ================= NATURE =================
  { emoji: '🔥', name: 'Fire', category: 'nature', keywords: ['lit', 'hot', 'awesome', 'streak', 'burn'] },
  { emoji: '⚡', name: 'High Voltage', category: 'nature', keywords: ['zap', 'lightning', 'fast', 'bitcoin', 'energy'] },
  { emoji: '✨', name: 'Sparkles', category: 'nature', keywords: ['magic', 'clean', 'shiny', 'new', 'polish'] },
  { emoji: '🌟', name: 'Glowing Star', category: 'nature', keywords: ['star', 'favorite', 'great', 'shine'] },
  { emoji: '💫', name: 'Dizzy Star', category: 'nature', keywords: ['wow', 'shooting star', 'magic'] },
  { emoji: '☀️', name: 'Sun', category: 'nature', keywords: ['gm', 'morning', 'bright', 'sunny'] },
  { emoji: '🌙', name: 'Crescent Moon', category: 'nature', keywords: ['gn', 'night', 'sleep', 'moon'] },
  { emoji: '🌈', name: 'Rainbow', category: 'nature', keywords: ['color', 'bright', 'hope'] },
  { emoji: '🌊', name: 'Water Wave', category: 'nature', keywords: ['wave', 'bitchat', 'flow', 'ocean', 'surf'] },
  { emoji: '❄️', name: 'Snowflake', category: 'nature', keywords: ['cold', 'ice', 'chill', 'freeze'] },
  { emoji: '🌪️', name: 'Tornado', category: 'nature', keywords: ['chaos', 'storm', 'wild'] },
  { emoji: '🌋', name: 'Volcano', category: 'nature', keywords: ['erupt', 'boom', 'intense'] },
  { emoji: '🌍', name: 'Globe Europe-Africa', category: 'nature', keywords: ['world', 'global', 'earth', 'geo'] },
  { emoji: '🌎', name: 'Globe Americas', category: 'nature', keywords: ['world', 'earth', 'global'] },
  { emoji: '🌱', name: 'Seedling', category: 'nature', keywords: ['grow', 'new', 'fresh', 'start'] },
  { emoji: '🍀', name: 'Four Leaf Clover', category: 'nature', keywords: ['luck', 'lucky', 'fortune'] },
  { emoji: '🌵', name: 'Cactus', category: 'nature', keywords: ['desert', 'sharp', 'resilient'] },
  { emoji: '🌹', name: 'Rose', category: 'nature', keywords: ['flower', 'romance', 'beauty'] },
  { emoji: '🌻', name: 'Sunflower', category: 'nature', keywords: ['happy', 'bright', 'summer'] },
  { emoji: '🐐', name: 'Goat', category: 'nature', keywords: ['greatest', 'legend', 'mvp', 'goat'] },
  { emoji: '🦅', name: 'Eagle', category: 'nature', keywords: ['freedom', 'soar', 'sharp'] },
  { emoji: '🦉', name: 'Owl', category: 'nature', keywords: ['wise', 'night', 'watch'] },
  { emoji: '🦊', name: 'Fox', category: 'nature', keywords: ['clever', 'sly', 'cute'] },
  { emoji: '🐺', name: 'Wolf', category: 'nature', keywords: ['pack', 'lone', 'wild'] },
  { emoji: '🦁', name: 'Lion', category: 'nature', keywords: ['brave', 'king', 'strong'] },
  { emoji: '🐻', name: 'Bear', category: 'nature', keywords: ['bearish', 'strong', 'hug'] },
  { emoji: '🐂', name: 'Ox', category: 'nature', keywords: ['bullish', 'pump', 'charge'] },
  { emoji: '🐳', name: 'Spouting Whale', category: 'nature', keywords: ['whale', 'big', 'ocean'] },
  { emoji: '🦈', name: 'Shark', category: 'nature', keywords: ['sharp', 'fast', 'ocean'] },
  { emoji: '🐙', name: 'Octopus', category: 'nature', keywords: ['multitask', 'ocean', 'smart'] },
  { emoji: '🦋', name: 'Butterfly', category: 'nature', keywords: ['transform', 'free', 'pretty'] },
  { emoji: '🐝', name: 'Honeybee', category: 'nature', keywords: ['busy', 'buzz', 'work'] },
  { emoji: '🐸', name: 'Frog', category: 'nature', keywords: ['pepe', 'meme', 'ribbit'] },
  { emoji: '🐶', name: 'Dog Face', category: 'nature', keywords: ['puppy', 'loyal', 'good boy'] },
  { emoji: '🐱', name: 'Cat Face', category: 'nature', keywords: ['kitty', 'meow', 'cute'] },
  { emoji: '🦄', name: 'Unicorn', category: 'nature', keywords: ['rare', 'magic', 'startup'] },
  { emoji: '🐉', name: 'Dragon', category: 'nature', keywords: ['epic', 'fire', 'power'] },
  { emoji: '🐦', name: 'Bird', category: 'nature', keywords: ['ostrich', 'tweet', 'fly', 'nostr'] },

  // ================= FOOD =================
  { emoji: '☕', name: 'Hot Beverage', category: 'food', keywords: ['coffee', 'gm', 'morning', 'tea', 'cafe'] },
  { emoji: '🍿', name: 'Popcorn', category: 'food', keywords: ['drama', 'watch', 'movie', 'snack'] },
  { emoji: '🍕', name: 'Pizza', category: 'food', keywords: ['bitcoin', 'food', 'slice', 'yum'] },
  { emoji: '🍔', name: 'Hamburger', category: 'food', keywords: ['burger', 'lunch', 'food'] },
  { emoji: '🌮', name: 'Taco', category: 'food', keywords: ['tuesday', 'food', 'yum'] },
  { emoji: '🍣', name: 'Sushi', category: 'food', keywords: ['japanese', 'food', 'fresh'] },
  { emoji: '🍜', name: 'Steaming Bowl', category: 'food', keywords: ['ramen', 'noodles', 'soup', 'hot'] },
  { emoji: '🥩', name: 'Cut of Meat', category: 'food', keywords: ['steak', 'beef', 'grill'] },
  { emoji: '🍪', name: 'Cookie', category: 'food', keywords: ['sweet', 'treat', 'snack'] },
  { emoji: '🍩', name: 'Doughnut', category: 'food', keywords: ['donut', 'sweet', 'treat'] },
  { emoji: '🎂', name: 'Birthday Cake', category: 'food', keywords: ['birthday', 'celebrate', 'cake'] },
  { emoji: '🍰', name: 'Shortcake', category: 'food', keywords: ['cake', 'dessert', 'sweet'] },
  { emoji: '🍫', name: 'Chocolate Bar', category: 'food', keywords: ['sweet', 'candy', 'snack'] },
  { emoji: '🍦', name: 'Soft Ice Cream', category: 'food', keywords: ['chill', 'dessert', 'summer'] },
  { emoji: '🍓', name: 'Strawberry', category: 'food', keywords: ['fruit', 'berry', 'sweet'] },
  { emoji: '🍑', name: 'Peach', category: 'food', keywords: ['fruit', 'juicy'] },
  { emoji: '🍋', name: 'Lemon', category: 'food', keywords: ['sour', 'citrus', 'fresh'] },
  { emoji: '🌶️', name: 'Hot Pepper', category: 'food', keywords: ['spicy', 'hot', 'take'] },
  { emoji: '🥑', name: 'Avocado', category: 'food', keywords: ['guac', 'fresh', 'toast'] },
  { emoji: '🍺', name: 'Beer Mug', category: 'food', keywords: ['cheers', 'drink', 'pub'] },
  { emoji: '🍻', name: 'Clinking Beer Mugs', category: 'food', keywords: ['cheers', 'celebrate', 'drinks'] },
  { emoji: '🥂', name: 'Clinking Glasses', category: 'food', keywords: ['toast', 'champagne', 'cheers', 'congrats'] },
  { emoji: '🍷', name: 'Wine Glass', category: 'food', keywords: ['wine', 'classy', 'drink'] },
  { emoji: '🥃', name: 'Tumbler Glass', category: 'food', keywords: ['whiskey', 'bourbon', 'cheers'] },
  { emoji: '🍵', name: 'Teacup', category: 'food', keywords: ['tea', 'matcha', 'zen', 'calm'] },

  // ================= SYMBOLS =================
  { emoji: '💯', name: 'Hundred Points', category: 'symbols', keywords: ['100', 'facts', 'true', 'real', 'agree'] },
  { emoji: '🟣', name: 'Purple Circle', category: 'symbols', keywords: ['nostr', 'purple', 'dot'] },
  { emoji: '🟠', name: 'Orange Circle', category: 'symbols', keywords: ['bitcoin', 'orange', 'dot'] },
  { emoji: '✅', name: 'Check Mark Button', category: 'symbols', keywords: ['done', 'yes', 'verified', 'shipped', 'ok'] },
  { emoji: '❌', name: 'Cross Mark', category: 'symbols', keywords: ['no', 'wrong', 'cancel', 'nope'] },
  { emoji: '❓', name: 'Question Mark', category: 'symbols', keywords: ['what', 'confused', 'why', 'ask'] },
  { emoji: '❗', name: 'Exclamation Mark', category: 'symbols', keywords: ['important', 'alert', 'wow'] },
  { emoji: '‼️', name: 'Double Exclamation', category: 'symbols', keywords: ['urgent', 'huge', 'big'] },
  { emoji: '⁉️', name: 'Exclamation Question', category: 'symbols', keywords: ['wtf', 'what', 'really'] },
  { emoji: '➕', name: 'Plus', category: 'symbols', keywords: ['add', 'agree', 'plus one', 'more'] },
  { emoji: '➖', name: 'Minus', category: 'symbols', keywords: ['less', 'remove', 'subtract'] },
  { emoji: '⬆️', name: 'Up Arrow', category: 'symbols', keywords: ['up', 'bump', 'this', 'upvote'] },
  { emoji: '⬇️', name: 'Down Arrow', category: 'symbols', keywords: ['down', 'drop', 'downvote'] },
  { emoji: '🔄', name: 'Counterclockwise Arrows', category: 'symbols', keywords: ['refresh', 'sync', 'loop', 'repost'] },
  { emoji: '♾️', name: 'Infinity', category: 'symbols', keywords: ['forever', 'loop', 'endless'] },
  { emoji: '⚠️', name: 'Warning', category: 'symbols', keywords: ['caution', 'careful', 'alert'] },
  { emoji: '🚫', name: 'Prohibited', category: 'symbols', keywords: ['ban', 'no', 'block', 'forbidden'] },
  { emoji: '🛑', name: 'Stop Sign', category: 'symbols', keywords: ['stop', 'halt', 'wait'] },
  { emoji: '🚩', name: 'Triangular Flag', category: 'symbols', keywords: ['red flag', 'warn', 'sus'] },
  { emoji: '🏁', name: 'Chequered Flag', category: 'symbols', keywords: ['finish', 'done', 'race', 'goal'] },
  { emoji: '💤', name: 'ZZZ', category: 'symbols', keywords: ['sleep', 'tired', 'boring', 'gn'] },
  { emoji: '💢', name: 'Anger Symbol', category: 'symbols', keywords: ['mad', 'annoyed', 'comic'] },
  { emoji: '💥', name: 'Collision', category: 'symbols', keywords: ['boom', 'bang', 'impact', 'hit'] },
  { emoji: '💬', name: 'Speech Balloon', category: 'symbols', keywords: ['chat', 'talk', 'comment', 'reply'] },
  { emoji: '💭', name: 'Thought Balloon', category: 'symbols', keywords: ['think', 'wonder', 'idea'] },
  { emoji: '🎵', name: 'Musical Note', category: 'symbols', keywords: ['music', 'vibe', 'song', 'tune'] },
  { emoji: '🎶', name: 'Musical Notes', category: 'symbols', keywords: ['music', 'jam', 'melody', 'vibe'] },
  { emoji: '🆘', name: 'SOS Button', category: 'symbols', keywords: ['help', 'emergency', 'rescue'] },
  { emoji: '🆕', name: 'NEW Button', category: 'symbols', keywords: ['new', 'fresh', 'release'] },
  { emoji: '🆙', name: 'UP! Button', category: 'symbols', keywords: ['up', 'level up', 'bump'] },
  { emoji: '🆒', name: 'COOL Button', category: 'symbols', keywords: ['cool', 'nice', 'neat'] },
  { emoji: '🆗', name: 'OK Button', category: 'symbols', keywords: ['ok', 'good', 'approved'] },
]

const CATALOG_BY_EMOJI = new Map<string, ReactionEmojiEntry>(
  REACTION_EMOJI_CATALOG.map((entry) => [entry.emoji, entry])
)

export function findReactionEmojiEntry(emoji: string): ReactionEmojiEntry | undefined {
  return CATALOG_BY_EMOJI.get(emoji)
}

export function sanitizePinnedReactions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_PINNED_REACTIONS]
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const clean = item.trim()
    if (!clean || clean.length > 16 || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= MAX_PINNED_REACTIONS) break
  }
  return out
}

function readStoredPinnedReactions(): readonly string[] {
  if (typeof window === 'undefined') return [...DEFAULT_PINNED_REACTIONS]
  try {
    const raw = window.localStorage.getItem(PINNED_REACTIONS_STORAGE_KEY)
    if (raw === null) return [...DEFAULT_PINNED_REACTIONS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_PINNED_REACTIONS]
    return sanitizePinnedReactions(parsed)
  } catch {
    return [...DEFAULT_PINNED_REACTIONS]
  }
}

function writeStoredPinnedReactions(next: readonly string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PINNED_REACTIONS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Ignore storage quota or restricted-mode errors
  }
}

let cachedPinned: readonly string[] | null = null
const listeners = new Set<() => void>()
let storageListenerAttached = false

function ensureCachedPinned(): readonly string[] {
  if (cachedPinned === null) {
    cachedPinned = readStoredPinnedReactions()
  }
  return cachedPinned
}

function emitPinnedChange(): void {
  for (const listener of listeners) {
    listener()
  }
}

function attachStorageListenerOnce(): void {
  if (storageListenerAttached || typeof window === 'undefined') return
  storageListenerAttached = true
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== null && e.key !== PINNED_REACTIONS_STORAGE_KEY) return
    const next = readStoredPinnedReactions()
    const prev = ensureCachedPinned()
    if (next.length === prev.length && next.every((val, idx) => val === prev[idx])) {
      return
    }
    cachedPinned = next
    emitPinnedChange()
  })
}

function subscribePinnedReactions(listener: () => void): () => void {
  attachStorageListenerOnce()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getPinnedReactionsSnapshot(): readonly string[] {
  return ensureCachedPinned()
}

function getServerPinnedSnapshot(): readonly string[] {
  return DEFAULT_PINNED_REACTIONS
}

export function getPinnedReactions(): readonly string[] {
  return ensureCachedPinned()
}

export function usePinnedReactions(): readonly string[] {
  return useSyncExternalStore(
    subscribePinnedReactions,
    getPinnedReactionsSnapshot,
    getServerPinnedSnapshot
  )
}

export function isDefaultPinnedReactions(pinned: readonly string[]): boolean {
  if (pinned.length !== DEFAULT_PINNED_REACTIONS.length) return false
  for (let i = 0; i < DEFAULT_PINNED_REACTIONS.length; i += 1) {
    if (pinned[i] !== DEFAULT_PINNED_REACTIONS[i]) return false
  }
  return true
}

function commitPinnedReactions(next: readonly string[]): readonly string[] {
  const sanitized = sanitizePinnedReactions([...next])
  cachedPinned = sanitized
  writeStoredPinnedReactions(sanitized)
  emitPinnedChange()
  return sanitized
}

export function togglePinnedReaction(emoji: string): {
  ok: boolean
  pinned: readonly string[]
  action?: 'pinned' | 'unpinned'
  reason?: 'limit'
} {
  const clean = emoji.trim()
  const current = ensureCachedPinned()
  if (!clean || clean.length > 16) {
    return { ok: false, pinned: current }
  }
  if (current.includes(clean)) {
    const next = commitPinnedReactions(current.filter((e) => e !== clean))
    return { ok: true, pinned: next, action: 'unpinned' }
  }
  if (current.length >= MAX_PINNED_REACTIONS) {
    return { ok: false, pinned: current, reason: 'limit' }
  }
  const next = commitPinnedReactions([...current, clean])
  return { ok: true, pinned: next, action: 'pinned' }
}

export function unpinReaction(emoji: string): readonly string[] {
  const clean = emoji.trim()
  const current = ensureCachedPinned()
  if (!clean || !current.includes(clean)) return current
  return commitPinnedReactions(current.filter((e) => e !== clean))
}

export function resetPinnedReactions(): readonly string[] {
  return commitPinnedReactions([...DEFAULT_PINNED_REACTIONS])
}
