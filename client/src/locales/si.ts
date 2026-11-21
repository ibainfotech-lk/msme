
import en from "./en";

const si: {
    [K in keyof typeof en]: (typeof en)[K] extends object
    ? { [C in keyof (typeof en)[K]]: string }
    : string;
} = {
    choose: "ඔබේ භාෂාව තෝරන්න",
    tagline: "ඔබේ ව්‍යාපාරය සඳහා සරල ගිණුම්කරණය",
    continue: "ඉදිරියට යන්න",
    login: "පිවිසෙන්න",
    register: "ලියාපදිංචි වන්න",
    dashboard: "ප්‍රධාන පුවරුව",
    welcome: "සාදරයෙන් පිළිගනිමු",

    // Phone registration
    phoneTitle: "ඔබගේ ජංගම දුරකථන අංකය ඇතුළත් කරන්න",
    phoneHelp: "ඉදිරියට යාමට ඔබගේ ජංගම දුරකථන අංකය ඇතුළත් කරන්න.",
    phoneLabel: "ජංගම දුරකථන අංකය",
    sendOtp: "OTP යවන්න",

    // OTP verification
    otpTitle: "OTP තහවුරු කිරීම",
    otpHelp: "ඔබගේ දුරකථනයට එවූ ඉලක්කම් හයක OTP අංකය ඇතුළත් කරන්න.",
    verify: "තහවුරු කරන්න",
    changePhone: "දුරකථන අංකය වෙනස් කරන්න",

    // Registration
    registerTitle: "ඔබගේ ගිණුම සාදන්න",
    fullName: "සම්පූර්ණ නම",
    emailLabel: "විද්‍යුත් තැපැල් ලිපිනය",
    invalidEmail: "වලංගු විද්‍යුත් තැපැල් ලිපිනයක් ඇතුළත් කරන්න.",
    businessName: "ව්‍යාපාරයේ නම",
    businessType: "ව්‍යාපාර වර්ගය",
    sole: "තනි පුද්ගල ව්‍යාපාරය",
    company: "පෞද්ගලික සීමිත සමාගම",
    community: "ප්‍රජා සංවිධානය",
    create: "ගිණුම සාදන්න",
    loginRegister: "පිවිසුම් පිටුවට යන්න",
    // Login
    loginTitle: "Noteto වෙත පිවිසෙන්න",
    registeredPhoneHelp: "ලියාපදිංචි කළ ජංගම දුරකථන අංකය ඇතුළත් කරන්න.",
    mobileNumber: "ජංගම දුරකථන අංකය",
    enterMobileNumber: "ඔබගේ ජංගම දුරකථන අංකය ඇතුළත් කරන්න.",
    loginFailed: "පිවිසීම අසාර්ථකයි. නැවත උත්සාහ කරන්න.",
    createAccount: "නව ගිණුමක් සාදන්න",
    useOtpInstead: "ඒ වෙනුවට OTP තහවුරු කිරීම භාවිතා කරන්න",
    resendOtp: "OTP නැවත යවන්න",
    invalidOtp: "කරුණාකර ඉලක්කම් හයක OTP අංකය ඇතුළත් කරන්න.",
    invalidAmount: "ශුන්‍යයට වඩා වැඩි මුදලක් ඇතුළත් කරන්න.",

    // Dashboard
    todayIncome: "අද ආදායම",
    todayExpense: "අද වියදම්",
    balance: "අද ශේෂය",
    income: "ආදායම",
    expense: "වියදම",
    history: "මෑත ගනුදෙනු",
    noTransactions: "තවම ගනුදෙනු නොමැත",
    amount: "මුදල",
    category: "වර්ගය",
    description: "විස්තරය",
    date: "දිනය",
    save: "ගනුදෙනුව සුරකින්න",
    cancel: "අවලංගු කරන්න",
    logout: "පිටවන්න",
    back: "ආපසු",
    required: "මෙම තොරතුර අවශ්‍යයි",
    genericError: "දෝෂයක් ඇතිවිය. නැවත උත්සාහ කරන්න.",
    saved: "ගනුදෙනුව සාර්ථකව සුරකින ලදී",
    loading: "පූරණය වෙමින්...",
    noBusiness: "මෙම ගිණුමට ව්‍යාපාරයක් සම්බන්ධ කර නැත",
    language: "භාෂාව",
    refresh: "ප්‍රධාන පුවරුව යාවත්කාලීන කරන්න",

    // Transaction categories
    sales: "විකුණුම්",
    services: "සේවා",
    otherIncome: "වෙනත් ආදායම්",
    rent: "කුලිය",
    utilities: "විදුලිය සහ ජලය",
    supplies: "සැපයුම්",
    transport: "ප්‍රවාහනය",
    salaries: "වැටුප්",
    otherExpense: "වෙනත් වියදම්",
};

export default si;
