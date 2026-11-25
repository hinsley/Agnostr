import { REACTION_EMOJI_CATALOG } from './reactionEmojis.ts'

export interface EmojiShortcodeEntry {
  readonly emoji: string
  readonly shortcode: string
  readonly name: string
  readonly aliases: readonly string[]
  readonly keywords: readonly string[]
}

export interface EmojiShortcodeToken {
  readonly start: number
  readonly end: number
  readonly query: string
  readonly closed: boolean
}

const RECENT_STORAGE_KEY = 'agnostr:v1:recent_emoji_shortcodes'
const MAX_RECENT_SHORTCODES = 16
const ALLOWED_PRECEDING_RE = /[\s([{'"—–]/
const SHORTCODE_TOKEN_RE = /:([a-zA-Z0-9_+-]{2,24})(:)?$/
const WORD_CHAR_RE = /[a-zA-Z0-9_+-]/

interface ShortcodeMeta {
  readonly shortcode: string
  readonly aliases?: readonly string[]
}

const CATALOG_SHORTCODE_MAP: Record<string, ShortcodeMeta> = {
  // Smileys
  '😂': { shortcode: 'joy', aliases: ['laugh', 'lol', 'tears_of_joy'] },
  '🤣': { shortcode: 'rofl', aliases: ['lmao'] },
  '😀': { shortcode: 'grinning', aliases: ['happy'] },
  '😊': { shortcode: 'blush', aliases: ['warm'] },
  '😁': { shortcode: 'grin', aliases: ['beaming'] },
  '🙂': { shortcode: 'slightly_smiling', aliases: ['slight_smile'] },
  '😉': { shortcode: 'wink' },
  '😍': { shortcode: 'heart_eyes', aliases: ['adore'] },
  '🥰': { shortcode: 'smiling_hearts', aliases: ['in_love', 'aww'] },
  '🤩': { shortcode: 'star_struck', aliases: ['starstruck'] },
  '😎': { shortcode: 'sunglasses', aliases: ['cool'] },
  '🥳': { shortcode: 'partying', aliases: ['party_face'] },
  '😏': { shortcode: 'smirk' },
  '🤔': { shortcode: 'thinking', aliases: ['think', 'hmm'] },
  '🤨': { shortcode: 'raised_eyebrow', aliases: ['sus'] },
  '🧐': { shortcode: 'monocle' },
  '😮': { shortcode: 'open_mouth', aliases: ['surprised'] },
  '😲': { shortcode: 'astonished', aliases: ['shocked'] },
  '🤯': { shortcode: 'exploding_head', aliases: ['mindblown', 'mind_blown'] },
  '😳': { shortcode: 'flushed', aliases: ['shy'] },
  '🥺': { shortcode: 'pleading', aliases: ['puppy_eyes'] },
  '🥹': { shortcode: 'holding_back_tears', aliases: ['touched'] },
  '😢': { shortcode: 'cry', aliases: ['sad', 'tear'] },
  '😭': { shortcode: 'sob', aliases: ['crying'] },
  '😤': { shortcode: 'triumph', aliases: ['huff'] },
  '😡': { shortcode: 'angry', aliases: ['mad', 'rage'] },
  '🤬': { shortcode: 'cursing', aliases: ['furious', 'swearing'] },
  '😱': { shortcode: 'scream', aliases: ['omg', 'panic'] },
  '😅': { shortcode: 'sweat_smile', aliases: ['phew'] },
  '😬': { shortcode: 'grimacing', aliases: ['yikes', 'cringe'] },
  '🫠': { shortcode: 'melting', aliases: ['melt'] },
  '🙃': { shortcode: 'upside_down', aliases: ['upside_down_face'] },
  '😴': { shortcode: 'sleeping', aliases: ['sleep'] },
  '🥱': { shortcode: 'yawning', aliases: ['yawn'] },
  '🤢': { shortcode: 'nauseated', aliases: ['sick'] },
  '🤮': { shortcode: 'vomiting', aliases: ['puke'] },
  '🤧': { shortcode: 'sneezing', aliases: ['achoo'] },
  '🤒': { shortcode: 'thermometer_face', aliases: ['fever'] },
  '🤓': { shortcode: 'nerd', aliases: ['geek'] },
  '🤠': { shortcode: 'cowboy', aliases: ['yeehaw'] },
  '🥸': { shortcode: 'disguised', aliases: ['incognito'] },
  '🤫': { shortcode: 'shushing', aliases: ['shh', 'quiet'] },
  '🤭': { shortcode: 'hand_over_mouth', aliases: ['oops', 'giggle'] },
  '🫣': { shortcode: 'peeking', aliases: ['peek'] },
  '🫢': { shortcode: 'gasp' },
  '🫡': { shortcode: 'salute', aliases: ['o7'] },
  '🫥': { shortcode: 'dotted_line_face', aliases: ['invisible'] },
  '😐': { shortcode: 'neutral', aliases: ['meh', 'neutral_face'] },
  '😑': { shortcode: 'expressionless', aliases: ['bruh'] },
  '🙄': { shortcode: 'rolling_eyes', aliases: ['eyeroll'] },
  '😒': { shortcode: 'unamused' },
  '😈': { shortcode: 'smiling_imp', aliases: ['devil', 'imp'] },
  '🤡': { shortcode: 'clown', aliases: ['clown_face'] },
  '💀': { shortcode: 'skull', aliases: ['dead', 'rip'] },
  '👻': { shortcode: 'ghost', aliases: ['boo'] },
  '👽': { shortcode: 'alien', aliases: ['ufo'] },
  '🤖': { shortcode: 'robot', aliases: ['bot'] },
  '💩': { shortcode: 'poop', aliases: ['hankey', 'shit'] },

  // Gestures
  '👍': { shortcode: 'thumbsup', aliases: ['+1', 'thumbs_up', 'like', 'yes'] },
  '👎': { shortcode: 'thumbsdown', aliases: ['-1', 'thumbs_down', 'dislike'] },
  '👀': { shortcode: 'eyes', aliases: ['look'] },
  '🙌': { shortcode: 'raised_hands', aliases: ['hooray', 'praise'] },
  '👏': { shortcode: 'clap', aliases: ['applause'] },
  '🙏': { shortcode: 'pray', aliases: ['thanks', 'please', 'namaste'] },
  '🤝': { shortcode: 'handshake', aliases: ['deal'] },
  '🤙': { shortcode: 'shaka', aliases: ['call_me', 'call_me_hand'] },
  '✌️': { shortcode: 'v', aliases: ['peace_hand', 'victory'] },
  '🤞': { shortcode: 'crossed_fingers', aliases: ['fingers_crossed', 'luck'] },
  '🤟': { shortcode: 'love_you_gesture', aliases: ['ily'] },
  '🤘': { shortcode: 'metal', aliases: ['rock_on'] },
  '👌': { shortcode: 'ok_hand', aliases: ['perfect'] },
  '🤌': { shortcode: 'pinched_fingers', aliases: ['chef_kiss'] },
  '🫶': { shortcode: 'heart_hands' },
  '💪': { shortcode: 'muscle', aliases: ['strong', 'biceps'] },
  '👋': { shortcode: 'wave', aliases: ['hello', 'hi', 'bye'] },
  '👊': { shortcode: 'fist_bump', aliases: ['punch'] },
  '✊': { shortcode: 'fist', aliases: ['raised_fist'] },
  '☝️': { shortcode: 'point_up' },
  '👆': { shortcode: 'point_up_2' },
  '👇': { shortcode: 'point_down' },
  '👉': { shortcode: 'point_right' },
  '👈': { shortcode: 'point_left' },
  '🫵': { shortcode: 'point_at_viewer' },
  '🤷': { shortcode: 'shrug', aliases: ['idk'] },
  '🤦': { shortcode: 'facepalm', aliases: ['smh'] },
  '🙆': { shortcode: 'ok_person' },
  '🙅': { shortcode: 'no_good', aliases: ['nope'] },
  '🧠': { shortcode: 'brain', aliases: ['smart'] },
  '🫂': { shortcode: 'hug', aliases: ['people_hugging'] },

  // Hearts
  '❤️': { shortcode: 'heart', aliases: ['red_heart', 'love'] },
  '🧡': { shortcode: 'orange_heart' },
  '💛': { shortcode: 'yellow_heart' },
  '💚': { shortcode: 'green_heart' },
  '💙': { shortcode: 'blue_heart' },
  '💜': { shortcode: 'purple_heart' },
  '🖤': { shortcode: 'black_heart' },
  '🤍': { shortcode: 'white_heart' },
  '🩷': { shortcode: 'pink_heart' },
  '🩵': { shortcode: 'light_blue_heart', aliases: ['cyan_heart'] },
  '💔': { shortcode: 'broken_heart', aliases: ['heartbreak'] },
  '❤️‍🔥': { shortcode: 'heart_on_fire', aliases: ['passion'] },
  '💖': { shortcode: 'sparkling_heart' },
  '💘': { shortcode: 'cupid', aliases: ['heart_arrow'] },
  '💝': { shortcode: 'gift_heart' },
  '💞': { shortcode: 'revolving_hearts' },
  '💋': { shortcode: 'kiss', aliases: ['lips'] },

  // Objects
  '🚀': { shortcode: 'rocket', aliases: ['launch', 'ship'] },
  '🎉': { shortcode: 'tada', aliases: ['party', 'celebrate', 'congrats'] },
  '🎊': { shortcode: 'confetti', aliases: ['confetti_ball'] },
  '🏆': { shortcode: 'trophy', aliases: ['win', 'winner'] },
  '🥇': { shortcode: 'first_place', aliases: ['gold_medal'] },
  '🎯': { shortcode: 'dart', aliases: ['bullseye', 'target'] },
  '💎': { shortcode: 'gem', aliases: ['diamond'] },
  '👑': { shortcode: 'crown', aliases: ['king', 'queen'] },
  '🔑': { shortcode: 'key', aliases: ['keys'] },
  '🔒': { shortcode: 'lock', aliases: ['locked', 'private'] },
  '🛡️': { shortcode: 'shield', aliases: ['protect'] },
  '💡': { shortcode: 'bulb', aliases: ['idea', 'lightbulb'] },
  '🔔': { shortcode: 'bell', aliases: ['notify'] },
  '📌': { shortcode: 'pin', aliases: ['pushpin'] },
  '📎': { shortcode: 'paperclip', aliases: ['attach'] },
  '📝': { shortcode: 'memo', aliases: ['note'] },
  '📚': { shortcode: 'books', aliases: ['study'] },
  '💻': { shortcode: 'laptop', aliases: ['computer', 'code'] },
  '📱': { shortcode: 'iphone', aliases: ['phone', 'mobile'] },
  '🛰️': { shortcode: 'satellite', aliases: ['relay'] },
  '📡': { shortcode: 'satellite_antenna', aliases: ['antenna', 'signal'] },
  '🎧': { shortcode: 'headphones', aliases: ['headphone'] },
  '🎤': { shortcode: 'microphone', aliases: ['mic'] },
  '🎬': { shortcode: 'clapper', aliases: ['movie', 'film'] },
  '📸': { shortcode: 'camera_flash', aliases: ['snap'] },
  '🎮': { shortcode: 'video_game', aliases: ['gaming', 'controller'] },
  '🎲': { shortcode: 'game_die', aliases: ['dice'] },
  '🧩': { shortcode: 'puzzle', aliases: ['jigsaw'] },
  '🔧': { shortcode: 'wrench', aliases: ['fix'] },
  '🔨': { shortcode: 'hammer', aliases: ['build'] },
  '⚙️': { shortcode: 'gear', aliases: ['settings', 'cog'] },
  '🧪': { shortcode: 'test_tube', aliases: ['lab', 'experiment'] },
  '💰': { shortcode: 'moneybag', aliases: ['money_bag', 'sats'] },
  '💸': { shortcode: 'money_with_wings', aliases: ['spend'] },
  '🪙': { shortcode: 'coin', aliases: ['bitcoin', 'mint'] },
  '🎁': { shortcode: 'gift', aliases: ['present'] },
  '🎈': { shortcode: 'balloon' },
  '💣': { shortcode: 'bomb' },
  '🧭': { shortcode: 'compass', aliases: ['navigate'] },
  '🗺️': { shortcode: 'world_map', aliases: ['map'] },
  '⏰': { shortcode: 'alarm_clock', aliases: ['alarm'] },
  '⏳': { shortcode: 'hourglass', aliases: ['wait'] },
  '🗑️': { shortcode: 'wastebasket', aliases: ['trash'] },

  // Nature
  '🔥': { shortcode: 'fire', aliases: ['lit', 'hot', 'flame'] },
  '⚡': { shortcode: 'zap', aliases: ['lightning', 'bolt'] },
  '✨': { shortcode: 'sparkles', aliases: ['sparkle', 'magic'] },
  '🌟': { shortcode: 'star2', aliases: ['glowing_star'] },
  '💫': { shortcode: 'dizzy', aliases: ['shooting_star'] },
  '☀️': { shortcode: 'sun', aliases: ['sunny', 'gm'] },
  '🌙': { shortcode: 'moon', aliases: ['crescent_moon', 'gn'] },
  '🌈': { shortcode: 'rainbow' },
  '🌊': { shortcode: 'ocean', aliases: ['water_wave', 'surf'] },
  '❄️': { shortcode: 'snowflake', aliases: ['cold', 'ice'] },
  '🌪️': { shortcode: 'tornado' },
  '🌋': { shortcode: 'volcano' },
  '🌍': { shortcode: 'earth_africa', aliases: ['earth', 'globe', 'world'] },
  '🌎': { shortcode: 'earth_americas' },
  '🌱': { shortcode: 'seedling', aliases: ['sprout', 'grow'] },
  '🍀': { shortcode: 'four_leaf_clover', aliases: ['clover', 'lucky'] },
  '🌵': { shortcode: 'cactus' },
  '🌹': { shortcode: 'rose', aliases: ['flower'] },
  '🌻': { shortcode: 'sunflower' },
  '🐐': { shortcode: 'goat', aliases: ['mvp'] },
  '🦅': { shortcode: 'eagle' },
  '🦉': { shortcode: 'owl' },
  '🦊': { shortcode: 'fox' },
  '🐺': { shortcode: 'wolf' },
  '🦁': { shortcode: 'lion' },
  '🐻': { shortcode: 'bear' },
  '🐂': { shortcode: 'ox', aliases: ['bull'] },
  '🐳': { shortcode: 'whale' },
  '🦈': { shortcode: 'shark' },
  '🐙': { shortcode: 'octopus' },
  '🦋': { shortcode: 'butterfly' },
  '🐝': { shortcode: 'bee', aliases: ['honeybee'] },
  '🐸': { shortcode: 'frog', aliases: ['pepe'] },
  '🐶': { shortcode: 'dog', aliases: ['puppy'] },
  '🐱': { shortcode: 'cat', aliases: ['kitty'] },
  '🦄': { shortcode: 'unicorn' },
  '🐉': { shortcode: 'dragon' },
  '🐦': { shortcode: 'ostrich', aliases: ['bird', 'nostr'] },

  // Food
  '☕': { shortcode: 'coffee', aliases: ['cafe', 'espresso'] },
  '🍿': { shortcode: 'popcorn' },
  '🍕': { shortcode: 'pizza' },
  '🍔': { shortcode: 'hamburger', aliases: ['burger'] },
  '🌮': { shortcode: 'taco' },
  '🍣': { shortcode: 'sushi' },
  '🍜': { shortcode: 'ramen', aliases: ['noodles'] },
  '🥩': { shortcode: 'steak', aliases: ['meat'] },
  '🍪': { shortcode: 'cookie' },
  '🍩': { shortcode: 'doughnut', aliases: ['donut'] },
  '🎂': { shortcode: 'birthday', aliases: ['birthday_cake'] },
  '🍰': { shortcode: 'cake', aliases: ['shortcake'] },
  '🍫': { shortcode: 'chocolate', aliases: ['chocolate_bar'] },
  '🍦': { shortcode: 'icecream', aliases: ['ice_cream'] },
  '🍓': { shortcode: 'strawberry' },
  '🍑': { shortcode: 'peach' },
  '🍋': { shortcode: 'lemon' },
  '🌶️': { shortcode: 'hot_pepper', aliases: ['spicy', 'chili'] },
  '🥑': { shortcode: 'avocado' },
  '🍺': { shortcode: 'beer' },
  '🍻': { shortcode: 'cheers', aliases: ['beers'] },
  '🥂': { shortcode: 'clinking_glasses', aliases: ['champagne', 'toast'] },
  '🍷': { shortcode: 'wine', aliases: ['wine_glass'] },
  '🥃': { shortcode: 'whiskey', aliases: ['tumbler_glass'] },
  '🍵': { shortcode: 'tea', aliases: ['matcha'] },

  // Symbols
  '💯': { shortcode: '100', aliases: ['hundred'] },
  '🟣': { shortcode: 'purple_circle' },
  '🟠': { shortcode: 'orange_circle' },
  '✅': { shortcode: 'check', aliases: ['white_check_mark', 'done', 'verified'] },
  '❌': { shortcode: 'x', aliases: ['cross', 'no', 'wrong'] },
  '❓': { shortcode: 'question' },
  '❗': { shortcode: 'exclamation', aliases: ['bang'] },
  '‼️': { shortcode: 'bangbang', aliases: ['double_exclamation'] },
  '⁉️': { shortcode: 'interrobang' },
  '➕': { shortcode: 'plus', aliases: ['heavy_plus_sign'] },
  '➖': { shortcode: 'minus', aliases: ['heavy_minus_sign'] },
  '⬆️': { shortcode: 'arrow_up', aliases: ['up'] },
  '⬇️': { shortcode: 'arrow_down', aliases: ['down'] },
  '🔄': { shortcode: 'arrows_counterclockwise', aliases: ['refresh', 'sync'] },
  '♾️': { shortcode: 'infinity' },
  '⚠️': { shortcode: 'warning', aliases: ['caution', 'alert'] },
  '🚫': { shortcode: 'no_entry_sign', aliases: ['prohibited', 'ban'] },
  '🛑': { shortcode: 'stop_sign', aliases: ['stop'] },
  '🚩': { shortcode: 'triangular_flag', aliases: ['red_flag', 'flag'] },
  '🏁': { shortcode: 'checkered_flag', aliases: ['finish'] },
  '💤': { shortcode: 'zzz' },
  '💢': { shortcode: 'anger' },
  '💥': { shortcode: 'boom', aliases: ['collision'] },
  '💬': { shortcode: 'speech_balloon', aliases: ['chat', 'comment'] },
  '💭': { shortcode: 'thought_balloon', aliases: ['thought'] },
  '🎵': { shortcode: 'musical_note', aliases: ['music', 'note_music'] },
  '🎶': { shortcode: 'notes', aliases: ['melody'] },
  '🆘': { shortcode: 'sos', aliases: ['help'] },
  '🆕': { shortcode: 'new' },
  '🆙': { shortcode: 'up_button' },
  '🆒': { shortcode: 'cool_button' },
  '🆗': { shortcode: 'ok', aliases: ['ok_button'] },
}

// ~115 extra everyday shortcodes spanning faces, animals, food, weather, travel, objects & symbols
const EXTRA_SHORTCODE_ENTRIES: readonly EmojiShortcodeEntry[] = [
  // Extra Smileys & People
  { emoji: '😄', shortcode: 'smile', name: 'Grinning Face with Smiling Eyes', aliases: ['smiley', 'happy_face'], keywords: ['joy', 'glad', 'cheerful'] },
  { emoji: '😆', shortcode: 'laughing', name: 'Grinning Squinting Face', aliases: ['satisfied', 'xd', 'haha'], keywords: ['laugh', 'funny'] },
  { emoji: '😋', shortcode: 'yum', name: 'Face Savoring Food', aliases: ['yummy', 'delicious'], keywords: ['tasty', 'tongue'] },
  { emoji: '😛', shortcode: 'stuck_out_tongue', name: 'Face with Tongue', aliases: ['tongue'], keywords: ['playful', 'silly'] },
  { emoji: '😜', shortcode: 'wink_tongue', name: 'Winking Face with Tongue', aliases: ['crazy_face'], keywords: ['silly', 'joke'] },
  { emoji: '🤪', shortcode: 'zany', name: 'Zany Face', aliases: ['goofy', 'wild'], keywords: ['silly', 'wacky'] },
  { emoji: '😘', shortcode: 'kissing_heart', name: 'Face Blowing a Kiss', aliases: ['kiss_heart', 'mwah'], keywords: ['love', 'flirt'] },
  { emoji: '😌', shortcode: 'relieved', name: 'Relieved Face', aliases: ['calm', 'peaceful'], keywords: ['relaxed', 'zen'] },
  { emoji: '😔', shortcode: 'pensive', name: 'Pensive Face', aliases: ['downcast'], keywords: ['sad', 'sorry', 'thoughtful'] },
  { emoji: '😕', shortcode: 'confused', name: 'Confused Face', aliases: ['puzzled'], keywords: ['unsure', 'huh'] },
  { emoji: '😟', shortcode: 'worried', name: 'Worried Face', aliases: ['anxious'], keywords: ['nervous', 'concern'] },
  { emoji: '🙁', shortcode: 'frown', name: 'Slightly Frowning Face', aliases: ['frowning'], keywords: ['sad', 'unhappy'] },
  { emoji: '😩', shortcode: 'weary', name: 'Weary Face', aliases: ['exhausted'], keywords: ['tired', 'ugh'] },
  { emoji: '😫', shortcode: 'tired', name: 'Tired Face', aliases: ['tired_face'], keywords: ['sleepy', 'done'] },
  { emoji: '🤐', shortcode: 'zipper_mouth', name: 'Zipper-Mouth Face', aliases: ['sealed', 'lips_sealed'], keywords: ['secret', 'quiet'] },
  { emoji: '😷', shortcode: 'mask', name: 'Face with Medical Mask', aliases: ['masked'], keywords: ['sick', 'health'] },
  { emoji: '🥶', shortcode: 'cold_face', name: 'Cold Face', aliases: ['freezing'], keywords: ['frozen', 'chill'] },
  { emoji: '🥵', shortcode: 'hot_face', name: 'Hot Face', aliases: ['sweating', 'overheated'], keywords: ['heat', 'spicy'] },
  { emoji: '🥴', shortcode: 'woozy', name: 'Woozy Face', aliases: ['tipsy', 'dizzy'], keywords: ['drunk', 'dazed'] },
  { emoji: '😵', shortcode: 'dizzy_face', name: 'Face with Crossed-Out Eyes', aliases: ['knocked_out'], keywords: ['stunned', 'whoa'] },
  { emoji: '😇', shortcode: 'innocent', name: 'Smiling Face with Halo', aliases: ['halo', 'angel'], keywords: ['good', 'pure'] },
  { emoji: '🤗', shortcode: 'hugging', name: 'Smiling Face with Open Hands', aliases: ['hugs', 'open_hands'], keywords: ['warm', 'welcome'] },
  { emoji: '🤑', shortcode: 'money_mouth', name: 'Money-Mouth Face', aliases: ['rich'], keywords: ['cash', 'profit'] },
  { emoji: '🥲', shortcode: 'smiling_tear', name: 'Smiling Face with Tear', aliases: ['bittersweet'], keywords: ['proud', 'grateful'] },
  { emoji: '😨', shortcode: 'fearful', name: 'Fearful Face', aliases: ['scared'], keywords: ['afraid', 'nervous'] },
  { emoji: '😰', shortcode: 'cold_sweat', name: 'Anxious Face with Sweat', aliases: ['nervous'], keywords: ['stress', 'worried'] },
  { emoji: '👾', shortcode: 'space_invader', name: 'Alien Monster', aliases: ['arcade', 'retro'], keywords: ['game', 'pixel'] },
  { emoji: '🕵️', shortcode: 'detective', name: 'Detective', aliases: ['sleuth', 'investigate'], keywords: ['spy', 'search'] },
  { emoji: '🧙', shortcode: 'mage', name: 'Mage', aliases: ['wizard'], keywords: ['magic', 'fantasy'] },
  { emoji: '🥷', shortcode: 'ninja', name: 'Ninja', aliases: ['stealth'], keywords: ['hidden', 'fast'] },
  { emoji: '✍️', shortcode: 'writing_hand', name: 'Writing Hand', aliases: ['write'], keywords: ['notes', 'sign'] },

  // Extra Animals
  { emoji: '🐼', shortcode: 'panda', name: 'Panda', aliases: ['panda_face'], keywords: ['bear', 'cute'] },
  { emoji: '🐨', shortcode: 'koala', name: 'Koala', aliases: [], keywords: ['australia', 'cute'] },
  { emoji: '🐯', shortcode: 'tiger', name: 'Tiger Face', aliases: [], keywords: ['cat', 'wild'] },
  { emoji: '🐵', shortcode: 'monkey', name: 'Monkey Face', aliases: ['monkey_face'], keywords: ['ape', 'cheeky'] },
  { emoji: '🙈', shortcode: 'see_no_evil', name: 'See-No-Evil Monkey', aliases: ['monkey_eyes'], keywords: ['oops', 'shy'] },
  { emoji: '🙉', shortcode: 'hear_no_evil', name: 'Hear-No-Evil Monkey', aliases: [], keywords: ['ignore', 'monkey'] },
  { emoji: '🙊', shortcode: 'speak_no_evil', name: 'Speak-No-Evil Monkey', aliases: [], keywords: ['oops', 'secret'] },
  { emoji: '🐧', shortcode: 'penguin', name: 'Penguin', aliases: ['linux', 'tux'], keywords: ['cold', 'bird'] },
  { emoji: '🦆', shortcode: 'duck', name: 'Duck', aliases: ['quack'], keywords: ['bird', 'pond'] },
  { emoji: '🐔', shortcode: 'chicken', name: 'Chicken', aliases: [], keywords: ['bird', 'farm'] },
  { emoji: '🐢', shortcode: 'turtle', name: 'Turtle', aliases: ['slow'], keywords: ['reptile', 'shell'] },
  { emoji: '🐍', shortcode: 'snake', name: 'Snake', aliases: ['python'], keywords: ['reptile', 'code'] },
  { emoji: '🐬', shortcode: 'dolphin', name: 'Dolphin', aliases: [], keywords: ['ocean', 'swim'] },
  { emoji: '🦀', shortcode: 'crab', name: 'Crab', aliases: ['rust'], keywords: ['ocean', 'ferris'] },
  { emoji: '🦐', shortcode: 'shrimp', name: 'Shrimp', aliases: [], keywords: ['seafood', 'ocean'] },
  { emoji: '🐌', shortcode: 'snail', name: 'Snail', aliases: [], keywords: ['slow', 'shell'] },
  { emoji: '🐛', shortcode: 'bug', name: 'Bug', aliases: ['insect'], keywords: ['debug', 'code'] },
  { emoji: '🕷️', shortcode: 'spider', name: 'Spider', aliases: ['web'], keywords: ['bug', 'spooky'] },
  { emoji: '🐴', shortcode: 'horse', name: 'Horse Face', aliases: ['pony'], keywords: ['ride', 'fast'] },
  { emoji: '🐷', shortcode: 'pig', name: 'Pig Face', aliases: ['oink'], keywords: ['farm', 'animal'] },
  { emoji: '🐮', shortcode: 'cow', name: 'Cow Face', aliases: ['moo'], keywords: ['farm', 'animal'] },
  { emoji: '🐰', shortcode: 'rabbit', name: 'Rabbit Face', aliases: ['bunny'], keywords: ['cute', 'hop'] },
  { emoji: '🐭', shortcode: 'mouse', name: 'Mouse Face', aliases: [], keywords: ['small', 'rodent'] },
  { emoji: '🦇', shortcode: 'bat', name: 'Bat', aliases: [], keywords: ['night', 'spooky'] },
  { emoji: '🐾', shortcode: 'paw_prints', name: 'Paw Prints', aliases: ['paws', 'paw'], keywords: ['pet', 'dog', 'cat'] },

  // Extra Food & Drink
  { emoji: '🍎', shortcode: 'apple', name: 'Red Apple', aliases: ['red_apple'], keywords: ['fruit', 'healthy'] },
  { emoji: '🍏', shortcode: 'green_apple', name: 'Green Apple', aliases: [], keywords: ['fruit', 'crisp'] },
  { emoji: '🍌', shortcode: 'banana', name: 'Banana', aliases: [], keywords: ['fruit', 'yellow'] },
  { emoji: '🍇', shortcode: 'grapes', name: 'Grapes', aliases: ['grape'], keywords: ['fruit', 'wine'] },
  { emoji: '🍉', shortcode: 'watermelon', name: 'Watermelon', aliases: [], keywords: ['fruit', 'summer'] },
  { emoji: '🍒', shortcode: 'cherries', name: 'Cherries', aliases: ['cherry'], keywords: ['fruit', 'sweet'] },
  { emoji: '🍊', shortcode: 'tangerine', name: 'Tangerine', aliases: ['orange_fruit'], keywords: ['citrus', 'fruit'] },
  { emoji: '🥭', shortcode: 'mango', name: 'Mango', aliases: [], keywords: ['tropical', 'fruit'] },
  { emoji: '🍍', shortcode: 'pineapple', name: 'Pineapple', aliases: [], keywords: ['tropical', 'fruit'] },
  { emoji: '🍞', shortcode: 'bread', name: 'Bread', aliases: ['loaf'], keywords: ['toast', 'bakery'] },
  { emoji: '🥐', shortcode: 'croissant', name: 'Croissant', aliases: [], keywords: ['pastry', 'breakfast'] },
  { emoji: '🧀', shortcode: 'cheese', name: 'Cheese Wedge', aliases: [], keywords: ['dairy', 'snack'] },
  { emoji: '🥚', shortcode: 'egg', name: 'Egg', aliases: [], keywords: ['breakfast', 'food'] },
  { emoji: '🥓', shortcode: 'bacon', name: 'Bacon', aliases: [], keywords: ['breakfast', 'crispy'] },
  { emoji: '🍟', shortcode: 'fries', name: 'French Fries', aliases: ['chips'], keywords: ['fast_food', 'snack'] },
  { emoji: '🌭', shortcode: 'hotdog', name: 'Hot Dog', aliases: ['hot_dog'], keywords: ['snack', 'grill'] },
  { emoji: '🌯', shortcode: 'burrito', name: 'Burrito', aliases: ['wrap'], keywords: ['mexican', 'lunch'] },
  { emoji: '🥗', shortcode: 'salad', name: 'Green Salad', aliases: [], keywords: ['healthy', 'veggie'] },
  { emoji: '🍝', shortcode: 'spaghetti', name: 'Spaghetti', aliases: ['pasta'], keywords: ['italian', 'dinner'] },
  { emoji: '🍚', shortcode: 'rice', name: 'Cooked Rice', aliases: [], keywords: ['bowl', 'meal'] },
  { emoji: '🧁', shortcode: 'cupcake', name: 'Cupcake', aliases: ['muffin'], keywords: ['dessert', 'sweet'] },
  { emoji: '🍬', shortcode: 'candy', name: 'Candy', aliases: [], keywords: ['sweet', 'treat'] },
  { emoji: '🍸', shortcode: 'cocktail', name: 'Cocktail Glass', aliases: ['martini'], keywords: ['drink', 'bar'] },
  { emoji: '🧋', shortcode: 'boba', name: 'Bubble Tea', aliases: ['bubble_tea'], keywords: ['drink', 'tea'] },
  { emoji: '💧', shortcode: 'droplet', name: 'Droplet', aliases: ['water', 'sweat_drop'], keywords: ['rain', 'hydrate'] },

  // Extra Nature & Weather
  { emoji: '⭐', shortcode: 'star', name: 'Star', aliases: ['fav', 'favorite'], keywords: ['gold', 'shine', 'rating'] },
  { emoji: '☁️', shortcode: 'cloud', name: 'Cloud', aliases: ['cloudy'], keywords: ['weather', 'sky'] },
  { emoji: '🌧️', shortcode: 'rain', name: 'Cloud with Rain', aliases: ['rainy'], keywords: ['weather', 'storm'] },
  { emoji: '⛈️', shortcode: 'storm', name: 'Cloud with Lightning and Rain', aliases: ['thunderstorm'], keywords: ['weather', 'thunder'] },
  { emoji: '💨', shortcode: 'dash', name: 'Dashing Away', aliases: ['wind', 'fast'], keywords: ['speed', 'whoosh'] },
  { emoji: '☂️', shortcode: 'umbrella', name: 'Umbrella', aliases: [], keywords: ['rain', 'weather'] },
  { emoji: '🌲', shortcode: 'evergreen_tree', name: 'Evergreen Tree', aliases: ['pine', 'tree'], keywords: ['forest', 'nature'] },
  { emoji: '🌴', shortcode: 'palm_tree', name: 'Palm Tree', aliases: ['tropical'], keywords: ['beach', 'vacation'] },
  { emoji: '🌸', shortcode: 'cherry_blossom', name: 'Cherry Blossom', aliases: ['sakura', 'blossom'], keywords: ['spring', 'flower'] },
  { emoji: '🌷', shortcode: 'tulip', name: 'Tulip', aliases: [], keywords: ['spring', 'flower'] },
  { emoji: '🍁', shortcode: 'maple_leaf', name: 'Maple Leaf', aliases: ['autumn', 'fall'], keywords: ['canada', 'leaf'] },
  { emoji: '🍄', shortcode: 'mushroom', name: 'Mushroom', aliases: ['shroom'], keywords: ['forest', 'fungi'] },
  { emoji: '🌕', shortcode: 'full_moon', name: 'Full Moon', aliases: [], keywords: ['night', 'space'] },
  { emoji: '☄️', shortcode: 'comet', name: 'Comet', aliases: ['meteor', 'asteroid'], keywords: ['space', 'sky'] },
  { emoji: '🌌', shortcode: 'milky_way', name: 'Milky Way', aliases: ['galaxy', 'cosmos'], keywords: ['space', 'stars'] },
  { emoji: '🪐', shortcode: 'ringed_planet', name: 'Ringed Planet', aliases: ['saturn', 'planet'], keywords: ['space', 'orbit'] },
  { emoji: '⛰️', shortcode: 'mountain', name: 'Mountain', aliases: ['peak'], keywords: ['hike', 'nature'] },
  { emoji: '🏖️', shortcode: 'beach', name: 'Beach with Umbrella', aliases: ['vacation'], keywords: ['ocean', 'summer'] },
  { emoji: '🏕️', shortcode: 'camping', name: 'Camping', aliases: ['camp'], keywords: ['outdoors', 'tent'] },

  // Extra Travel, Places, Objects & Symbols
  { emoji: '🚗', shortcode: 'car', name: 'Automobile', aliases: ['drive'], keywords: ['vehicle', 'road'] },
  { emoji: '🚆', shortcode: 'train', name: 'Train', aliases: ['rail'], keywords: ['transit', 'travel'] },
  { emoji: '✈️', shortcode: 'airplane', name: 'Airplane', aliases: ['plane', 'flight'], keywords: ['travel', 'fly'] },
  { emoji: '🚢', shortcode: 'ship', name: 'Ship', aliases: ['boat'], keywords: ['ocean', 'sail'] },
  { emoji: '🚲', shortcode: 'bike', name: 'Bicycle', aliases: ['bicycle'], keywords: ['cycle', 'ride'] },
  { emoji: '⚓', shortcode: 'anchor', name: 'Anchor', aliases: [], keywords: ['ship', 'sea', 'stable'] },
  { emoji: '🏠', shortcode: 'house', name: 'House', aliases: ['home'], keywords: ['building', 'live'] },
  { emoji: '✉️', shortcode: 'envelope', name: 'Envelope', aliases: ['mail', 'email'], keywords: ['letter', 'inbox'] },
  { emoji: '📦', shortcode: 'package', name: 'Package', aliases: ['box', 'parcel'], keywords: ['deliver', 'release'] },
  { emoji: '📅', shortcode: 'calendar', name: 'Calendar', aliases: ['date', 'schedule'], keywords: ['event', 'plan'] },
  { emoji: '🕒', shortcode: 'clock', name: 'Three O’Clock', aliases: ['time'], keywords: ['hour', 'watch'] },
  { emoji: '🔋', shortcode: 'battery', name: 'Battery', aliases: ['power'], keywords: ['charge', 'energy'] },
  { emoji: '🔌', shortcode: 'electric_plug', name: 'Electric Plug', aliases: ['plug'], keywords: ['power', 'connect'] },
  { emoji: '🔍', shortcode: 'mag', name: 'Magnifying Glass', aliases: ['search', 'zoom'], keywords: ['find', 'inspect'] },
  { emoji: '📷', shortcode: 'camera', name: 'Camera', aliases: ['photo'], keywords: ['picture', 'lens'] },
  { emoji: '📖', shortcode: 'book', name: 'Open Book', aliases: ['read'], keywords: ['docs', 'learn'] },
  { emoji: '🔖', shortcode: 'bookmark', name: 'Bookmark', aliases: ['save'], keywords: ['tag', 'mark'] },
  { emoji: '✏️', shortcode: 'pencil', name: 'Pencil', aliases: ['edit'], keywords: ['write', 'draw'] },
  { emoji: '✂️', shortcode: 'scissors', name: 'Scissors', aliases: ['cut'], keywords: ['snip', 'trim'] },
  { emoji: '📁', shortcode: 'folder', name: 'File Folder', aliases: ['directory'], keywords: ['files', 'docs'] },
  { emoji: '📈', shortcode: 'chart_up', name: 'Chart Increasing', aliases: ['stonks', 'chart', 'growth'], keywords: ['trend', 'up'] },
  { emoji: '📉', shortcode: 'chart_down', name: 'Chart Decreasing', aliases: ['dip'], keywords: ['trend', 'down'] },
  { emoji: '📋', shortcode: 'clipboard', name: 'Clipboard', aliases: ['paste'], keywords: ['list', 'copy'] },
  { emoji: '📣', shortcode: 'megaphone', name: 'Megaphone', aliases: ['announce'], keywords: ['broadcast', 'loud'] },
  { emoji: '🔊', shortcode: 'loud_sound', name: 'Speaker High Volume', aliases: ['speaker', 'volume'], keywords: ['audio', 'sound'] },
  { emoji: '🔇', shortcode: 'mute', name: 'Muted Speaker', aliases: ['silent'], keywords: ['audio', 'quiet'] },
  { emoji: '🎸', shortcode: 'guitar', name: 'Guitar', aliases: ['rock'], keywords: ['music', 'band'] },
  { emoji: '🎨', shortcode: 'art', name: 'Artist Palette', aliases: ['palette', 'paint'], keywords: ['design', 'creative'] },
  { emoji: '⚽', shortcode: 'soccer', name: 'Soccer Ball', aliases: ['football_soccer'], keywords: ['sport', 'goal'] },
  { emoji: '🏀', shortcode: 'basketball', name: 'Basketball', aliases: ['hoops'], keywords: ['sport', 'ball'] },
  { emoji: '⚔️', shortcode: 'crossed_swords', name: 'Crossed Swords', aliases: ['swords', 'battle'], keywords: ['duel', 'fight'] },
  { emoji: '🔭', shortcode: 'telescope', name: 'Telescope', aliases: [], keywords: ['space', 'stars', 'astronomy'] },
  { emoji: '🔬', shortcode: 'microscope', name: 'Microscope', aliases: ['science'], keywords: ['lab', 'research'] },
  { emoji: '➡️', shortcode: 'arrow_right', name: 'Right Arrow', aliases: ['right'], keywords: ['next', 'forward'] },
  { emoji: '⬅️', shortcode: 'arrow_left', name: 'Left Arrow', aliases: ['left'], keywords: ['back', 'prev'] },
  { emoji: '♻️', shortcode: 'recycle', name: 'Recycling Symbol', aliases: ['eco'], keywords: ['green', 'reuse'] },
  { emoji: '☮️', shortcode: 'peace', name: 'Peace Symbol', aliases: [], keywords: ['calm', 'harmony'] },
  { emoji: '🟢', shortcode: 'green_circle', name: 'Green Circle', aliases: ['online'], keywords: ['dot', 'status', 'go'] },
  { emoji: '🔴', shortcode: 'red_circle', name: 'Red Circle', aliases: ['live_dot'], keywords: ['dot', 'record', 'stop'] },
  { emoji: '🔵', shortcode: 'blue_circle', name: 'Blue Circle', aliases: [], keywords: ['dot', 'blue'] },
  { emoji: '🟡', shortcode: 'yellow_circle', name: 'Yellow Circle', aliases: [], keywords: ['dot', 'yellow'] },
]

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function buildCatalog(): readonly EmojiShortcodeEntry[] {
  const seenShortcodes = new Set<string>()
  const seenEmojis = new Set<string>()
  const entries: EmojiShortcodeEntry[] = []

  // First add every curated extra entry whose shortcode is primary (like `smile` 😄, `star` ⭐)
  // while keeping REACTION_EMOJI_CATALOG entries first-class
  const pushEntry = (entry: EmojiShortcodeEntry) => {
    if (!entry.shortcode || seenShortcodes.has(entry.shortcode) || seenEmojis.has(entry.emoji)) {
      return
    }
    seenShortcodes.add(entry.shortcode)
    seenEmojis.add(entry.emoji)
    entries.push(entry)
  }

  for (const item of REACTION_EMOJI_CATALOG) {
    const meta = CATALOG_SHORTCODE_MAP[item.emoji]
    const shortcode = meta?.shortcode ?? slugifyName(item.name)
    const aliases = (meta?.aliases ?? []).map((a) => a.toLowerCase())
    const keywords = item.keywords
      .map((k) => k.toLowerCase().trim())
      .filter((k) => k.length > 0 && k !== shortcode && !aliases.includes(k))
    pushEntry({
      emoji: item.emoji,
      shortcode,
      name: item.name,
      aliases,
      keywords,
    })
  }

  for (const extra of EXTRA_SHORTCODE_ENTRIES) {
    pushEntry({
      emoji: extra.emoji,
      shortcode: extra.shortcode.toLowerCase(),
      name: extra.name,
      aliases: extra.aliases.map((a) => a.toLowerCase()),
      keywords: extra.keywords.map((k) => k.toLowerCase()),
    })
  }

  return entries
}

export const EMOJI_SHORTCODE_CATALOG: readonly EmojiShortcodeEntry[] = buildCatalog()

const EXACT_SHORTCODE_MAP = new Map<string, EmojiShortcodeEntry>()
const EXACT_ALIAS_MAP = new Map<string, EmojiShortcodeEntry>()

for (const entry of EMOJI_SHORTCODE_CATALOG) {
  if (!EXACT_SHORTCODE_MAP.has(entry.shortcode)) {
    EXACT_SHORTCODE_MAP.set(entry.shortcode, entry)
  }
}

for (const entry of EMOJI_SHORTCODE_CATALOG) {
  for (const alias of entry.aliases) {
    if (!EXACT_SHORTCODE_MAP.has(alias) && !EXACT_ALIAS_MAP.has(alias)) {
      EXACT_ALIAS_MAP.set(alias, entry)
    }
  }
}

let recentCache: string[] | null = null

function readRecentShortcodes(): string[] {
  if (recentCache !== null) return recentCache
  if (typeof window === 'undefined') {
    recentCache = []
    return recentCache
  }
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY)
    if (!raw) {
      recentCache = []
      return recentCache
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      recentCache = []
      return recentCache
    }
    recentCache = parsed
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .slice(0, MAX_RECENT_SHORTCODES)
    return recentCache
  } catch {
    recentCache = []
    return recentCache
  }
}

export function recordRecentEmojiShortcode(shortcode: string): void {
  const clean = shortcode.trim().toLowerCase()
  if (!clean) return
  const current = readRecentShortcodes()
  const next = [clean, ...current.filter((s) => s !== clean)].slice(0, MAX_RECENT_SHORTCODES)
  recentCache = next
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Ignore storage quota / private mode errors
  }
}

export function extractEmojiShortcodeToken(
  text: string,
  caret: number,
): EmojiShortcodeToken | null {
  if (!text || caret < 3 || caret > text.length) return null
  const before = text.slice(0, caret)
  const match = SHORTCODE_TOKEN_RE.exec(before)
  if (!match) return null

  const fullMatch = match[0]
  const rawQuery = match[1]
  const closed = Boolean(match[2])
  const start = caret - fullMatch.length

  // Only trigger at start of input or after whitespace / opening punctuation
  // (prevents triggering inside URLs https://..., timestamps 12:30, hex/npub, or #mars:s000)
  if (start > 0 && !ALLOWED_PRECEDING_RE.test(text[start - 1])) {
    return null
  }

  // While open (:query), do not trigger if caret sits in the middle of a continuous word
  if (!closed && caret < text.length && WORD_CHAR_RE.test(text[caret])) {
    return null
  }

  const query = rawQuery.toLowerCase()
  if (query.length < 2 || query.length > 24) return null

  return {
    start,
    end: caret,
    query,
    closed,
  }
}

export function findExactEmojiShortcode(query: string): EmojiShortcodeEntry | null {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return null
  return EXACT_SHORTCODE_MAP.get(q) ?? EXACT_ALIAS_MAP.get(q) ?? null
}

export function searchEmojiShortcodes(query: string, limit = 8): EmojiShortcodeEntry[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2 || limit <= 0) return []

  const recents = readRecentShortcodes()
  const recentRank = new Map<string, number>()
  for (let i = 0; i < recents.length; i += 1) {
    recentRank.set(recents[i], i)
  }

  const scored: Array<{ entry: EmojiShortcodeEntry; tier: number; recentIdx: number; lenDiff: number }> = []

  for (const entry of EMOJI_SHORTCODE_CATALOG) {
    let tier = -1
    let matchedLen = entry.shortcode.length
    if (entry.shortcode === q) {
      tier = 0
    } else if (entry.aliases.includes(q)) {
      tier = 1
      matchedLen = q.length
    } else if (entry.shortcode.startsWith(q)) {
      tier = 2
    } else {
      const prefixAlias = entry.aliases.find((a) => a.startsWith(q))
      if (prefixAlias) {
        tier = 2.5
        matchedLen = prefixAlias.length
      } else if (
        entry.keywords.some((k) => k.startsWith(q)) ||
        entry.name
          .toLowerCase()
          .split(/[\s-]+/)
          .some((w) => w.startsWith(q))
      ) {
        tier = 3
      } else if (
        entry.shortcode.includes(q) ||
        entry.aliases.some((a) => a.includes(q)) ||
        entry.keywords.some((k) => k.includes(q)) ||
        entry.name.toLowerCase().includes(q)
      ) {
        tier = 4
      }
    }

    if (tier === -1) continue

    const rIdx = recentRank.get(entry.shortcode)
    // Boost recently chosen emojis slightly within prefix/keyword tiers without overriding exact matches
    const effectiveTier =
      rIdx !== undefined && tier >= 2 ? tier - 0.35 : tier

    scored.push({
      entry,
      tier: effectiveTier,
      recentIdx: rIdx ?? 999,
      lenDiff: Math.abs(matchedLen - q.length),
    })
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.recentIdx !== b.recentIdx) return a.recentIdx - b.recentIdx
    if (a.lenDiff !== b.lenDiff) return a.lenDiff - b.lenDiff
    return a.entry.shortcode.localeCompare(b.entry.shortcode)
  })

  return scored.slice(0, limit).map((s) => s.entry)
}
