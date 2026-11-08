
import en from "./en";

const ta: {
    [K in keyof typeof en]: (typeof en)[K] extends object
    ? { [C in keyof (typeof en)[K]]: string }
    : string;
} = {
    choose: "உங்கள் மொழியைத் தேர்ந்தெடுக்கவும்",
    tagline: "உங்கள் வணிகத்திற்கான எளிய கணக்குப் பதிவு",
    continue: "தொடரவும்",
    login: "உள்நுழையவும்",
    register: "பதிவு செய்யவும்",
    dashboard: "முகப்புப் பலகை",
    welcome: "வரவேற்கிறோம்",

    // Phone registration
    phoneTitle: "உங்கள் கைப்பேசி எண்ணை உள்ளிடவும்",
    phoneHelp: "தொடர்வதற்கு உங்கள் கைப்பேசி எண்ணை உள்ளிடவும்.",
    phoneLabel: "கைப்பேசி எண்",
    sendOtp: "OTP அனுப்பவும்",

    // OTP verification
    otpTitle: "OTP சரிபார்ப்பு",
    otpHelp: "உங்கள் கைப்பேசிக்கு அனுப்பப்பட்ட ஆறு இலக்க OTP-ஐ உள்ளிடவும்.",
    verify: "சரிபார்க்கவும்",
    changePhone: "கைப்பேசி எண்ணை மாற்றவும்",

    // Registration
    registerTitle: "உங்கள் கணக்கை உருவாக்கவும்",
    fullName: "முழுப் பெயர்",
    businessName: "வணிகத்தின் பெயர்",
    businessType: "வணிக வகை",
    sole: "தனிநபர் வணிகம்",
    company: "தனியார் வரையறுக்கப்பட்ட நிறுவனம்",
    community: "சமூக அமைப்பு",
    create: "கணக்கை உருவாக்கவும்",
    loginRegister: "உள்நுழையும் பக்கத்துக்கு செல்லவும் ",

    // Login
    loginTitle: "Noteto-வில் உள்நுழையவும்",
    registeredPhoneHelp: "ஏற்கனவே பதிவு செய்த கைப்பேசி எண்ணை உள்ளிடவும்.",
    mobileNumber: "கைப்பேசி எண்",
    enterMobileNumber: "உங்கள் கைப்பேசி எண்ணை உள்ளிடவும்.",
    loginFailed: "உள்நுழைவு தோல்வியடைந்தது. மீண்டும் முயற்சிக்கவும்.",
    createAccount: "புதிய கணக்கை உருவாக்கவும்",
    useOtpInstead: "அதற்குப் பதிலாக OTP சரிபார்ப்பைப் பயன்படுத்தவும்",
    resendOtp: "OTP-ஐ மீண்டும் அனுப்பவும்",
    invalidOtp: "ஆறு இலக்க OTP எண்ணை உள்ளிடவும்.",
    invalidAmount: "பூஜ்ஜியத்தை விட அதிகமான தொகையை உள்ளிடவும்.",

    // Dashboard
    todayIncome: "இன்றைய வருமானம்",
    todayExpense: "இன்றைய செலவுகள்",
    balance: "இன்றைய இருப்பு",
    income: "வருமானம்",
    expense: "செலவு",
    history: "சமீபத்திய பரிவர்த்தனைகள்",
    noTransactions: "இதுவரை பரிவர்த்தனைகள் இல்லை",
    amount: "தொகை",
    category: "வகை",
    description: "விவரம்",
    date: "தேதி",
    save: "பரிவர்த்தனையைச் சேமிக்கவும்",
    cancel: "ரத்துசெய்",
    logout: "வெளியேறு",
    back: "பின்னால்",
    required: "இந்த விவரம் அவசியம்",
    genericError: "பிழை ஏற்பட்டது. மீண்டும் முயற்சிக்கவும்.",
    saved: "பரிவர்த்தனை வெற்றிகரமாகச் சேமிக்கப்பட்டது",
    loading: "ஏற்றப்படுகிறது...",
    noBusiness: "இந்தக் கணக்குடன் வணிகம் இணைக்கப்படவில்லை",
    language: "மொழி",
    refresh: "முகப்புப் பலகையைப் புதுப்பிக்கவும்",

    // Transaction categories
    sales: "விற்பனை",
    services: "சேவைகள்",
    otherIncome: "பிற வருமானம்",
    rent: "வாடகை",
    utilities: "மின்சாரம் மற்றும் தண்ணீர்",
    supplies: "பொருட்கள்",
    transport: "போக்குவரத்து",
    salaries: "சம்பளம்",
    otherExpense: "பிற செலவு",
};

export default ta;
