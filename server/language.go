package main

import (
	"regexp"
	"strings"
	"unicode"
)

func hindiText(text string) bool {
	return strings.ContainsFunc(text, func(r rune) bool { return unicode.In(r, unicode.Devanagari) })
}

// Romanized Hindi needs command words or grammar, not Indian names or an
// English greeting such as "hi". Quoted message content is not a preference
// for the assistant's reply language.
var romanHindiCommand = regexp.MustCompile(`(?i)\b(?:mujhe|mujhko|humein|hamein|humko|chahiye|batao|bataiye|likho|likhna|likhdo|bhejo|bhejna|dilana|dilao|kijiye|karo|kardo|dhoondo|dhoondho|dhundo|dhundho)\b|\b(?:kya|kaisa|kaisi|kaise|kitne|kitna|kitni)\s+(?:hai|hain|ho|aap|tum|hoga|hogi|baje)\b|\b(?:mein|me|ka|ki|ke|ko)\s+(?:mausam|samay|khabar|samachar|yaad|badal|kar|likh|bhej)\b|\b(?:kar|karna)\s+(?:do|dena|hai)\b`)

// Empty preserves the English wire format. Every fresh turn defaults to
// English; a model's unsupported "hi" flag must not switch its confirmation.
func replyLanguage(transcript string) string {
	command := unquotedCommand(transcript)
	if hindiText(command) || romanHindiCommand.MatchString(command) {
		return "hi"
	}
	return ""
}

func hindiQuestion(question string) string {
	if translated, ok := hindiQuestions[question]; ok {
		return translated
	}
	if strings.HasPrefix(question, "Which contact should I use for ") {
		name, _, _ := strings.Cut(strings.TrimPrefix(question, "Which contact should I use for "), "? Add the contact")
		return name + " के लिए कौन सा संपर्क चुनूँ? संपर्क जोड़कर पूरा अनुरोध फिर से बोलें।"
	}
	if strings.HasPrefix(question, "Which ") && strings.HasSuffix(question, " should I draft the email to?") {
		return "किस " + strings.TrimSuffix(strings.TrimPrefix(question, "Which "), " should I draft the email to?") + " को ईमेल ड्राफ्ट करना है?"
	}
	return question // Groq writes other Hindi clarifications directly.
}

var hindiQuestions = map[string]string{
	"Which reminder should I move?":                          "कौन सा रिमाइंडर बदलना है?",
	"What time should I move the reminder to?":               "रिमाइंडर का समय क्या रखना है?",
	"Which draft should I update?":                           "कौन सा ईमेल ड्राफ्ट बदलना है?",
	"When should the event start?":                           "इवेंट कब शुरू होना चाहिए?",
	"How long should the event last?":                        "इवेंट कितनी देर का होना चाहिए?",
	"Which city or landmark?":                                "कौन सा शहर या जगह?",
	"Which city?":                                            "कौन सा शहर?",
	"I couldn't resolve that place. Which city and country?": "यह जगह नहीं मिली। किस शहर और देश की बात कर रहे हैं?",
	"Which region and country is that city in?":              "यह शहर किस राज्य और देश में है?",
}

var hindiLookupMessages = map[string]string{
	"The results and their sources are ready to open.":                                       "उत्तर और स्रोत खोलकर देख सकते हैं।",
	"I couldn't find usable sources for that search.":                                        "इस खोज के लिए भरोसेमंद स्रोत नहीं मिले।",
	"I couldn't confirm named properties near that location from the search results.":        "उस जगह के पास होटल के नामों की पुष्टि नहीं हो सकी।",
	"I found no relevant stories with a confirmed publication time in the requested window.": "इस समय अवधि में प्रकाशन समय वाली कोई संबंधित खबर नहीं मिली।",
	"I couldn't confirm a relevant answer from the returned sources.":                        "मिले हुए स्रोतों से उत्तर की पुष्टि नहीं हो सकी।",
	"I found sources, but couldn't confirm a short answer. Open a source for details.":       "स्रोत मिले, लेकिन छोटे उत्तर की पुष्टि नहीं हो सकी। जानकारी के लिए स्रोत खोलें।",
}

func hindiLookupMessage(message string) string {
	if translated, ok := hindiLookupMessages[message]; ok {
		return translated
	}
	return message
}

func latinDigits(text string) string {
	return strings.Map(func(r rune) rune {
		if r >= '०' && r <= '९' {
			return '0' + r - '०'
		}
		return r
	}, text)
}
