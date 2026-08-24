/// Guard-facing strings, in the languages guards actually speak.
///
/// This is not a nice-to-have. The guard is the user least likely to read English and
/// the one who cannot ask anyone for help at 3am — the resident app can lean on English
/// far more safely than this one can.
///
/// Written as a plain map rather than ARB/gen-l10n on purpose: the app has to work with
/// no network and no platform locale services, the string set is small, and a missing
/// key falls back to English rather than crashing. A gate app that throws because a
/// translation is absent is worse than one showing an English word.
///
/// The verdict strings are the ones that matter most. A guard has to tell "expired
/// yesterday" from "not genuine" at a glance — one means call the flat, the other means
/// call the committee — so those are translated first and phrased as actions.
library;

enum AppLanguage {
  english('en', 'English'),
  hindi('hi', 'हिन्दी'),
  kannada('kn', 'ಕನ್ನಡ'),
  tamil('ta', 'தமிழ்'),
  telugu('te', 'తెలుగు'),
  marathi('mr', 'मराठी'),
  bengali('bn', 'বাংলা'),
  malayalam('ml', 'മലയാളം');

  const AppLanguage(this.code, this.label);
  final String code;

  /// The language's own name in its own script. A guard looking for their language
  /// should not have to read English to find it.
  final String label;

  static AppLanguage fromCode(String code) => AppLanguage.values.firstWhere(
        (l) => l.code == code,
        orElse: () => AppLanguage.english,
      );
}

const Map<String, Map<String, String>> _strings = {
  'en': {
    'scan': 'Scan pass',
    'allow': 'Allow entry',
    'deny': 'Deny',
    'valid': 'Pass is valid',
    'expired': 'This pass has expired',
    'showLivePass': 'Ask for the live pass in their app',
    'notYetValid': 'This pass is not valid yet',
    'notGenuine': 'This pass is not genuine',
    'wrongSociety': 'Issued for a different society',
    'unknownKey': 'Cannot check offline — connect this device',
    'malformed': 'This is not an entry pass',
    'offline': 'Offline',
    'queued': 'queued',
    'shiftStart': 'Start shift',
    'shiftEnd': 'End shift',
    'shiftEnded': 'Shift ended. Resident details on this device were erased.',
    'visitor': 'Visitor',
    'flat': 'Flat',
    'entry': 'Entry',
    'exit': 'Exit',
    'sync': 'Sync now',
    'synced': 'All entries uploaded',
    'needsAttention': 'entries need attention',
  },
  'hi': {
    'scan': 'पास स्कैन करें',
    'allow': 'प्रवेश दें',
    'deny': 'मना करें',
    'valid': 'पास वैध है',
    'expired': 'यह पास समाप्त हो चुका है',
    'showLivePass': 'ऐप में लाइव पास दिखाने को कहें',
    'notYetValid': 'यह पास अभी वैध नहीं है',
    'notGenuine': 'यह पास असली नहीं है',
    'wrongSociety': 'किसी दूसरी सोसाइटी के लिए जारी',
    'unknownKey': 'ऑफ़लाइन जाँच नहीं — डिवाइस को कनेक्ट करें',
    'malformed': 'यह प्रवेश पास नहीं है',
    'offline': 'ऑफ़लाइन',
    'queued': 'कतार में',
    'shiftStart': 'शिफ़्ट शुरू करें',
    'shiftEnd': 'शिफ़्ट समाप्त करें',
    'shiftEnded': 'शिफ़्ट समाप्त। इस डिवाइस से निवासी विवरण मिटा दिए गए।',
    'visitor': 'आगंतुक',
    'flat': 'फ़्लैट',
    'entry': 'प्रवेश',
    'exit': 'निकास',
    'sync': 'अभी सिंक करें',
    'synced': 'सभी प्रविष्टियाँ अपलोड हो गईं',
    'needsAttention': 'प्रविष्टियों पर ध्यान दें',
  },
  'kn': {
    'scan': 'ಪಾಸ್ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ',
    'allow': 'ಪ್ರವೇಶ ನೀಡಿ',
    'deny': 'ನಿರಾಕರಿಸಿ',
    'valid': 'ಪಾಸ್ ಮಾನ್ಯವಾಗಿದೆ',
    'expired': 'ಈ ಪಾಸ್ ಅವಧಿ ಮುಗಿದಿದೆ',
    'showLivePass': 'ಅವರ ಆ್ಯಪ್‌ನಲ್ಲಿ ಲೈವ್ ಪಾಸ್ ಕೇಳಿ',
    'notYetValid': 'ಈ ಪಾಸ್ ಇನ್ನೂ ಮಾನ್ಯವಾಗಿಲ್ಲ',
    'notGenuine': 'ಈ ಪಾಸ್ ನಿಜವಾದದ್ದಲ್ಲ',
    'wrongSociety': 'ಬೇರೆ ಸೊಸೈಟಿಗಾಗಿ ನೀಡಲಾಗಿದೆ',
    'unknownKey': 'ಆಫ್‌ಲೈನ್ ಪರಿಶೀಲಿಸಲಾಗಲಿಲ್ಲ — ಸಾಧನವನ್ನು ಸಂಪರ್ಕಿಸಿ',
    'malformed': 'ಇದು ಪ್ರವೇಶ ಪಾಸ್ ಅಲ್ಲ',
    'offline': 'ಆಫ್‌ಲೈನ್',
    'queued': 'ಸರತಿಯಲ್ಲಿ',
    'shiftStart': 'ಪಾಳಿ ಪ್ರಾರಂಭಿಸಿ',
    'shiftEnd': 'ಪಾಳಿ ಮುಗಿಸಿ',
    'shiftEnded': 'ಪಾಳಿ ಮುಗಿದಿದೆ. ಈ ಸಾಧನದಿಂದ ನಿವಾಸಿ ವಿವರಗಳನ್ನು ಅಳಿಸಲಾಗಿದೆ.',
    'visitor': 'ಸಂದರ್ಶಕ',
    'flat': 'ಫ್ಲ್ಯಾಟ್',
    'entry': 'ಪ್ರವೇಶ',
    'exit': 'ನಿರ್ಗಮನ',
    'sync': 'ಈಗ ಸಿಂಕ್ ಮಾಡಿ',
    'synced': 'ಎಲ್ಲಾ ನಮೂದುಗಳು ಅಪ್‌ಲೋಡ್ ಆಗಿವೆ',
    'needsAttention': 'ನಮೂದುಗಳಿಗೆ ಗಮನ ಬೇಕು',
  },
  'ta': {
    'scan': 'பாஸ் ஸ்கேன் செய்யவும்',
    'allow': 'அனுமதி',
    'deny': 'மறு',
    'valid': 'பாஸ் செல்லுபடியாகும்',
    'expired': 'இந்த பாஸ் காலாவதியானது',
    'showLivePass': 'அவர்களின் ஆப்பில் நேரடி பாஸ் கேளுங்கள்',
    'notYetValid': 'இந்த பாஸ் இன்னும் செல்லாது',
    'notGenuine': 'இந்த பாஸ் உண்மையானது அல்ல',
    'wrongSociety': 'வேறு சொசைட்டிக்கு வழங்கப்பட்டது',
    'unknownKey': 'ஆஃப்லைனில் சரிபார்க்க முடியாது — இணைக்கவும்',
    'malformed': 'இது நுழைவு பாஸ் அல்ல',
    'offline': 'ஆஃப்லைன்',
    'queued': 'வரிசையில்',
    'shiftStart': 'ஷிஃப்ட் தொடங்கு',
    'shiftEnd': 'ஷிஃப்ட் முடி',
    'shiftEnded': 'ஷிஃப்ட் முடிந்தது. குடியிருப்பாளர் விவரங்கள் அழிக்கப்பட்டன.',
    'visitor': 'வருகையாளர்',
    'flat': 'பிளாட்',
    'entry': 'நுழைவு',
    'exit': 'வெளியேறு',
    'sync': 'இப்போது ஒத்திசை',
    'synced': 'அனைத்தும் பதிவேற்றப்பட்டன',
    'needsAttention': 'பதிவுகளுக்கு கவனம் தேவை',
  },
  'te': {
    'scan': 'పాస్ స్కాన్ చేయండి',
    'allow': 'ప్రవేశం ఇవ్వండి',
    'deny': 'తిరస్కరించు',
    'valid': 'పాస్ చెల్లుబాటు అవుతుంది',
    'expired': 'ఈ పాస్ గడువు ముగిసింది',
    'showLivePass': 'వారి యాప్‌లో లైవ్ పాస్ అడగండి',
    'notYetValid': 'ఈ పాస్ ఇంకా చెల్లదు',
    'notGenuine': 'ఈ పాస్ నిజమైనది కాదు',
    'wrongSociety': 'వేరే సొసైటీ కోసం జారీ చేయబడింది',
    'unknownKey': 'ఆఫ్‌లైన్‌లో తనిఖీ చేయలేము — కనెక్ట్ చేయండి',
    'malformed': 'ఇది ప్రవేశ పాస్ కాదు',
    'offline': 'ఆఫ్‌లైన్',
    'queued': 'క్యూలో',
    'shiftStart': 'షిఫ్ట్ ప్రారంభించండి',
    'shiftEnd': 'షిఫ్ట్ ముగించండి',
    'shiftEnded': 'షిఫ్ట్ ముగిసింది. నివాసి వివరాలు తొలగించబడ్డాయి.',
    'visitor': 'సందర్శకుడు',
    'flat': 'ఫ్లాట్',
    'entry': 'ప్రవేశం',
    'exit': 'నిష్క్రమణ',
    'sync': 'ఇప్పుడే సింక్ చేయండి',
    'synced': 'అన్నీ అప్‌లోడ్ అయ్యాయి',
    'needsAttention': 'ఎంట్రీలకు శ్రద్ధ అవసరం',
  },
  'mr': {
    'scan': 'पास स्कॅन करा',
    'allow': 'प्रवेश द्या',
    'deny': 'नकार द्या',
    'valid': 'पास वैध आहे',
    'expired': 'हा पास कालबाह्य झाला आहे',
    'showLivePass': 'त्यांच्या अ‍ॅपमधील लाइव्ह पास मागा',
    'notYetValid': 'हा पास अद्याप वैध नाही',
    'notGenuine': 'हा पास खरा नाही',
    'wrongSociety': 'दुसऱ्या सोसायटीसाठी जारी',
    'unknownKey': 'ऑफलाइन तपासता येत नाही — कनेक्ट करा',
    'malformed': 'हा प्रवेश पास नाही',
    'offline': 'ऑफलाइन',
    'queued': 'रांगेत',
    'shiftStart': 'शिफ्ट सुरू करा',
    'shiftEnd': 'शिफ्ट संपवा',
    'shiftEnded': 'शिफ्ट संपली. रहिवासी तपशील मिटवले गेले.',
    'visitor': 'अभ्यागत',
    'flat': 'फ्लॅट',
    'entry': 'प्रवेश',
    'exit': 'निर्गमन',
    'sync': 'आता सिंक करा',
    'synced': 'सर्व नोंदी अपलोड झाल्या',
    'needsAttention': 'नोंदींकडे लक्ष द्या',
  },
  'bn': {
    'scan': 'পাস স্ক্যান করুন',
    'allow': 'প্রবেশ দিন',
    'deny': 'অস্বীকার',
    'valid': 'পাস বৈধ',
    'expired': 'এই পাসের মেয়াদ শেষ',
    'showLivePass': 'তাদের অ্যাপে লাইভ পাস চান',
    'notYetValid': 'এই পাস এখনও বৈধ নয়',
    'notGenuine': 'এই পাস আসল নয়',
    'wrongSociety': 'অন্য সোসাইটির জন্য জারি',
    'unknownKey': 'অফলাইনে যাচাই করা যাচ্ছে না — সংযোগ করুন',
    'malformed': 'এটি প্রবেশ পাস নয়',
    'offline': 'অফলাইন',
    'queued': 'সারিতে',
    'shiftStart': 'শিফট শুরু করুন',
    'shiftEnd': 'শিফট শেষ করুন',
    'shiftEnded': 'শিফট শেষ। বাসিন্দার তথ্য মুছে ফেলা হয়েছে।',
    'visitor': 'দর্শনার্থী',
    'flat': 'ফ্ল্যাট',
    'entry': 'প্রবেশ',
    'exit': 'প্রস্থান',
    'sync': 'এখনই সিঙ্ক করুন',
    'synced': 'সব আপলোড হয়েছে',
    'needsAttention': 'এন্ট্রিতে মনোযোগ দরকার',
  },
  'ml': {
    'scan': 'പാസ് സ്കാൻ ചെയ്യുക',
    'allow': 'പ്രവേശനം അനുവദിക്കുക',
    'deny': 'നിരസിക്കുക',
    'valid': 'പാസ് സാധുവാണ്',
    'expired': 'ഈ പാസിന്റെ കാലാവധി കഴിഞ്ഞു',
    'showLivePass': 'അവരുടെ ആപ്പിൽ ലൈവ് പാസ് ചോദിക്കുക',
    'notYetValid': 'ഈ പാസ് ഇതുവരെ സാധുവല്ല',
    'notGenuine': 'ഈ പാസ് യഥാർത്ഥമല്ല',
    'wrongSociety': 'മറ്റൊരു സൊസൈറ്റിക്ക് നൽകിയത്',
    'unknownKey': 'ഓഫ്‌ലൈനിൽ പരിശോധിക്കാനാകില്ല — കണക്ട് ചെയ്യുക',
    'malformed': 'ഇത് പ്രവേശന പാസ് അല്ല',
    'offline': 'ഓഫ്‌ലൈൻ',
    'queued': 'ക്യൂവിൽ',
    'shiftStart': 'ഷിഫ്റ്റ് ആരംഭിക്കുക',
    'shiftEnd': 'ഷിഫ്റ്റ് അവസാനിപ്പിക്കുക',
    'shiftEnded': 'ഷിഫ്റ്റ് അവസാനിച്ചു. താമസക്കാരുടെ വിവരങ്ങൾ മായ്ച്ചു.',
    'visitor': 'സന്ദർശകൻ',
    'flat': 'ഫ്ലാറ്റ്',
    'entry': 'പ്രവേശനം',
    'exit': 'പുറത്തുകടക്കൽ',
    'sync': 'ഇപ്പോൾ സിങ്ക് ചെയ്യുക',
    'synced': 'എല്ലാം അപ്‌ലോഡ് ചെയ്തു',
    'needsAttention': 'എൻട്രികൾക്ക് ശ്രദ്ധ വേണം',
  },
};

class Strings {
  const Strings(this.language);

  final AppLanguage language;

  /// Look up a key, falling back to English and then to the key itself.
  ///
  /// Never throws. A gate app that crashes because a translation is missing is worse
  /// than one showing an English word to a guard who was expecting Kannada.
  String call(String key) =>
      _strings[language.code]?[key] ?? _strings['en']?[key] ?? key;
}

/// Every key the app uses, for the completeness test.
List<String> get stringKeys => _strings['en']!.keys.toList();

/// Exposed so the test can assert coverage without reaching into private state.
Map<String, Map<String, String>> get allTranslations => _strings;
