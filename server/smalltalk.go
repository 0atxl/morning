package main

import (
	"fmt"
	"strings"
	"time"
	"unicode"
)

type talkKind int

const (
	talkNone talkKind = iota
	talkGreeting
	talkMorning
	talkAfternoon
	talkEvening
	talkNight
	talkHowAreYou
	talkThanks
	talkBye
	talkName
	talkCapabilities
	talkTime
	talkDate
	talkDay
	talkSorry
	talkAck
	talkLaugh
)

var talkPhrases = map[string]talkKind{
	"hi": talkGreeting, "hii": talkGreeting, "hello": talkGreeting, "hi hello": talkGreeting,
	"hey": talkGreeting, "hey there": talkGreeting, "hi there": talkGreeting, "hello there": talkGreeting,
	"hey hey": talkGreeting, "yo": talkGreeting, "hola": talkGreeting,
	"namaste": talkGreeting, "namaskar": talkGreeting,
	"नमस्ते": talkGreeting, "नमस्कार": talkGreeting, "हेलो": talkGreeting, "हैलो": talkGreeting, "हाय": talkGreeting,

	"good morning": talkMorning, "सुप्रभात": talkMorning, "शुभ प्रभात": talkMorning,
	"good afternoon": talkAfternoon,
	"good evening":   talkEvening,
	"good night":     talkNight, "शुभ रात्रि": talkNight,

	"how are you": talkHowAreYou, "how are you doing": talkHowAreYou, "how do you do": talkHowAreYou,
	"how is it going": talkHowAreYou, "hows it going": talkHowAreYou, "whats up": talkHowAreYou, "what is up": talkHowAreYou,
	"sup": talkHowAreYou, "how have you been": talkHowAreYou, "how are you today": talkHowAreYou,
	"hello how are you": talkHowAreYou, "hi how are you": talkHowAreYou,
	"आप कैसे हैं": talkHowAreYou, "कैसे हो": talkHowAreYou, "तुम कैसे हो": talkHowAreYou, "कैसी हो": talkHowAreYou,
	"kaise ho": talkHowAreYou, "aap kaise hain": talkHowAreYou,

	"thanks": talkThanks, "thank you": talkThanks, "thank you so much": talkThanks, "thanks a lot": talkThanks,
	"thanks so much": talkThanks, "thank you very much": talkThanks, "many thanks": talkThanks, "thx": talkThanks,
	"thank u": talkThanks, "cheers": talkThanks, "much appreciated": talkThanks,
	"धन्यवाद": talkThanks, "शुक्रिया": talkThanks, "थैंक यू": talkThanks, "dhanyavaad": talkThanks, "shukriya": talkThanks,

	"bye": talkBye, "goodbye": talkBye, "good bye": talkBye, "bye bye": talkBye, "see you": talkBye,
	"see you later": talkBye, "see you soon": talkBye, "talk to you later": talkBye, "catch you later": talkBye,
	"take care": talkBye, "ttyl": talkBye,
	"अलविदा": talkBye, "बाय": talkBye, "फिर मिलेंगे": talkBye,

	"what is your name": talkName, "whats your name": talkName, "who are you": talkName, "your name": talkName,
	"tell me your name": talkName, "introduce yourself": talkName, "tell me about yourself": talkName,
	"what are you": talkName, "who am i talking to": talkName,
	"तुम्हारा नाम क्या है": talkName, "आपका नाम क्या है": talkName, "तुम कौन हो": talkName, "आप कौन हैं": talkName,

	"what can you do": talkCapabilities, "what can you do for me": talkCapabilities,
	"could you tell me what you can do for me": talkCapabilities, "can you tell me what you can do": talkCapabilities,
	"what do you do": talkCapabilities, "how can you help me": talkCapabilities, "how can you help": talkCapabilities,
	"can you help me": talkCapabilities, "help": talkCapabilities, "help me": talkCapabilities,
	"what are your features": talkCapabilities, "what can i ask you": talkCapabilities, "what can i say": talkCapabilities,
	"आप क्या कर सकते हैं": talkCapabilities, "तुम क्या कर सकते हो": talkCapabilities, "तुम्हारा काम क्या है": talkCapabilities,
	"aap kya kar sakte hain": talkCapabilities, "tum kya kar sakte ho": talkCapabilities,

	"what time is it": talkTime, "what is the time": talkTime, "whats the time": talkTime, "current time": talkTime,
	"time now": talkTime, "tell me the time": talkTime, "what is the time now": talkTime, "what is the current time": talkTime,
	"whats the time now": talkTime, "time please": talkTime, "can you tell me the time": talkTime,
	"what time is it now": talkTime, "the time": talkTime,
	"अभी क्या समय हुआ है": talkTime, "समय क्या हुआ है": talkTime, "टाइम क्या हुआ है": talkTime,
	"अभी कितने बजे हैं": talkTime, "कितने बजे हैं": talkTime, "abhi kitne baje hain": talkTime, "kitne baje hain": talkTime,

	"what is the date": talkDate, "whats the date": talkDate, "what is the date today": talkDate,
	"whats the date today": talkDate, "todays date": talkDate, "what is todays date": talkDate,
	"whats todays date": talkDate, "what date is it": talkDate, "what date is today": talkDate,
	"tell me the date": talkDate, "current date": talkDate, "date today": talkDate,
	"आज की तारीख क्या है": talkDate, "आज कौन सी तारीख है": talkDate, "aaj ki tarikh kya hai": talkDate,

	"what day is it": talkDay, "what day is today": talkDay, "which day is today": talkDay,
	"what day is it today": talkDay, "what is today": talkDay, "whats today": talkDay, "which day is it": talkDay,
	"आज कौन सा दिन है": talkDay, "आज कौन सा वार है": talkDay, "aaj kaun sa din hai": talkDay,

	"sorry": talkSorry, "im sorry": talkSorry, "my bad": talkSorry, "oops": talkSorry, "excuse me": talkSorry,
	"माफ़ करना": talkSorry, "सॉरी": talkSorry,

	"ok": talkAck, "okay": talkAck, "cool": talkAck, "nice": talkAck, "great": talkAck, "awesome": talkAck,
	"alright": talkAck, "got it": talkAck, "perfect": talkAck, "nice work": talkAck, "good job": talkAck,
	"अच्छा": talkAck, "ठीक है": talkAck, "बढ़िया": talkAck, "ओके": talkAck,

	"haha": talkLaugh, "lol": talkLaugh, "hahaha": talkLaugh, "हाहा": talkLaugh,
}

var assistantWakeWords = map[string]bool{"morning": true}

func normalizeSmallTalk(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r == '\'' || r == '’' || r == '`':
		case unicode.IsLetter(r) || unicode.IsMark(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		default:
			b.WriteRune(' ')
		}
	}
	words := strings.Fields(b.String())
	if len(words) == 0 {
		return ""
	}
	joined := strings.Join(words, " ")
	if _, ok := talkPhrases[joined]; ok {
		return joined
	}
	// Strip wake word "morning" only when other words remain (so "good morning" stays intact above).
	filtered := make([]string, 0, len(words))
	for _, w := range words {
		if !assistantWakeWords[w] {
			filtered = append(filtered, w)
		}
	}
	if len(filtered) > 0 {
		words = filtered
	}
	if len(words) > 1 {
		switch words[0] {
		case "hey", "hi", "hello", "ok", "okay", "oh", "so", "um", "well", "please":
			if _, ok := talkPhrases[strings.Join(words, " ")]; !ok {
				words = words[1:]
			}
		}
	}
	return strings.Join(words, " ")
}

// smallTalk handles everyday greetings, thanks, capability checks and local
// clock/date questions instantaneously with zero LLM token usage.
func smallTalk(transcript string, now time.Time, location *time.Location, lang string) (string, bool) {
	norm := normalizeSmallTalk(transcript)
	if norm == "" || len([]rune(norm)) > 72 {
		return "", false
	}
	kind, ok := talkPhrases[norm]
	if !ok {
		return "", false
	}
	local := now.In(location)
	hi := lang == "hi"
	switch kind {
	case talkGreeting:
		h := local.Hour()
		if hi {
			if h < 12 {
				return "नमस्ते, शुभ प्रभात! मैं Morning हूँ। रिमाइंडर, ईमेल ड्राफ्ट, मौसम या किसी भी जानकारी के लिए पूछें।", true
			}
			if h < 17 {
				return "नमस्ते! मैं Morning हूँ। बताइए, मैं आपकी कैसे मदद कर सकती हूँ?", true
			}
			return "नमस्ते, शुभ संध्या! मैं Morning हूँ। आज मैं आपकी क्या मदद कर सकती हूँ?", true
		}
		if h < 12 {
			return "Good morning! I'm Morning. Ask me for a reminder, an email draft, weather, news, or any quick lookup.", true
		}
		if h < 17 {
			return "Hello! I'm Morning. Ask me for a reminder, an email draft, or any quick lookup.", true
		}
		return "Good evening! I'm Morning. How can I help with reminders, email drafts, or quick lookups?", true
	case talkMorning:
		if hi {
			return "शुभ प्रभात! बताइए, क्या रिमाइंडर सेट करना है, ईमेल ड्राफ्ट बनाना है, या आज की ब्रीफिंग चाहिए?", true
		}
		return "Good morning! Ready when you are. Ask for a reminder, an email draft, or your morning briefing.", true
	case talkAfternoon:
		if hi {
			return "नमस्ते! आज मैं आपकी क्या मदद कर सकती हूँ?", true
		}
		return "Good afternoon! How can I help you today?", true
	case talkEvening:
		if hi {
			return "शुभ संध्या! बताइए, क्या याद दिलाना है या क्या खोजना है?", true
		}
		return "Good evening! What can I help you with?", true
	case talkNight:
		if hi {
			return "शुभ रात्रि! आपके रिमाइंडर सुरक्षित हैं।", true
		}
		return "Good night! Your saved reminders and drafts are safe here.", true
	case talkHowAreYou:
		if hi {
			return "मैं बिल्कुल ठीक हूँ, पूछने के लिए धन्यवाद! बताइए, मैं आपकी कैसे मदद कर सकती हूँ?", true
		}
		return "I'm doing great, thanks for asking! What can I help you with?", true
	case talkThanks:
		if hi {
			return "आपका स्वागत है! जब भी ज़रूरत हो, बस बोलिए।", true
		}
		return "You're welcome! Let me know whenever you need anything else.", true
	case talkBye:
		if hi {
			return "अलविदा! फिर मिलेंगे।", true
		}
		return "Goodbye! Talk to you soon.", true
	case talkName:
		if hi {
			return "मैं Morning हूँ, आपकी वॉइस असिस्टेंट। मैं रिमाइंडर, ईमेल ड्राफ्ट, मीटिंग मिनट्स और वेब खोज में मदद करती हूँ।", true
		}
		return "I'm Morning, your voice assistant for reminders, editable email drafts, meeting minutes, and fast web lookups.", true
	case talkCapabilities:
		if hi {
			return "मैं रिमाइंडर सेव, अपडेट व डिलीट कर सकती हूँ, ईमेल ड्राफ्ट बना व बदल सकती हूँ, मीटिंग मिनट्स लिख सकती हूँ, और मौसम, खबर या वेब खोज कर सकती हूँ।", true
		}
		return "I can create, update, or delete local reminders and email drafts, summarize meeting minutes, and run sourced web, news, weather, and daily briefing lookups.", true
	case talkTime:
		if hi {
			return fmt.Sprintf("अभी %s बजे हैं।", local.Format("3:04 PM")), true
		}
		return fmt.Sprintf("It's %s.", local.Format("3:04 PM")), true
	case talkDate:
		if hi {
			return fmt.Sprintf("आज %s है।", local.Format("02-01-2006")), true
		}
		return fmt.Sprintf("Today is %s.", local.Format("Monday, 2 January 2006")), true
	case talkDay:
		if hi {
			days := map[time.Weekday]string{
				time.Sunday: "रविवार", time.Monday: "सोमवार", time.Tuesday: "मंगलवार",
				time.Wednesday: "बुधवार", time.Thursday: "गुरुवार", time.Friday: "शुक्रवार", time.Saturday: "शनिवार",
			}
			return fmt.Sprintf("आज %s है।", days[local.Weekday()]), true
		}
		return fmt.Sprintf("Today is %s.", local.Format("Monday")), true
	case talkSorry:
		if hi {
			return "कोई बात नहीं!", true
		}
		return "No problem at all!", true
	case talkAck:
		if hi {
			return "बढ़िया! और कुछ चाहिए तो बताइए।", true
		}
		return "Sounds good! Let me know if you need anything else.", true
	case talkLaugh:
		if hi {
			return "बहुत बढ़िया! बताइए और क्या मदद करूँ?", true
		}
		return "Glad that helped! Anything else I can do?", true
	}
	return "", false
}
