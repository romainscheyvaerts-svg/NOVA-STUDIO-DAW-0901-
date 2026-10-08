/*
    NovaARAHost — JSON minimal (valeurs, lecture RFC 8259, écriture sur une ligne) et base64.
    (c) Make Music. Aucune dépendance tierce.
*/
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <locale.h>
#include <string>
#include <utility>
#include <vector>

namespace nova
{
    namespace json
    {
        class Value
        {
        public:
            enum class Type { Null, Bool, Number, String, Array, Object };

            Value() = default;
            Value (std::nullptr_t) {}
            Value (bool b) : t (Type::Bool), boolean (b) {}
            Value (int v) : t (Type::Number), number (v) {}
            Value (unsigned v) : t (Type::Number), number (v) {}
            Value (long v) : t (Type::Number), number (v) {}
            Value (long long v) : t (Type::Number), number ((double) v) {}
            Value (unsigned long long v) : t (Type::Number), number ((double) v) {}
            Value (double v) : t (Type::Number), number (v) {}
            Value (float v) : t (Type::Number), number (v) {}
            Value (const char* s) : t (Type::String), str (s != nullptr ? s : "") {}
            Value (std::string s) : t (Type::String), str (std::move (s)) {}

            static Value array() { Value v; v.t = Type::Array; return v; }
            static Value object() { Value v; v.t = Type::Object; return v; }

            Type type() const { return t; }
            bool isNull() const { return t == Type::Null; }
            bool isBool() const { return t == Type::Bool; }
            bool isNumber() const { return t == Type::Number; }
            bool isString() const { return t == Type::String; }
            bool isArray() const { return t == Type::Array; }
            bool isObject() const { return t == Type::Object; }

            const Value& operator[] (const std::string& key) const
            {
                if (t == Type::Object)
                    for (auto& kv : obj)
                        if (kv.first == key) return kv.second;
                return nullValue();
            }
            bool has (const std::string& key) const
            {
                if (t == Type::Object)
                    for (auto& kv : obj)
                        if (kv.first == key) return true;
                return false;
            }
            void set (const std::string& key, Value v)
            {
                if (t != Type::Object) { *this = object(); }
                for (auto& kv : obj)
                    if (kv.first == key) { kv.second = std::move (v); return; }
                obj.emplace_back (key, std::move (v));
            }
            void push (Value v)
            {
                if (t != Type::Array) { *this = array(); }
                arr.push_back (std::move (v));
            }
            size_t size() const { return t == Type::Array ? arr.size() : t == Type::Object ? obj.size() : 0; }
            const Value& at (size_t i) const { return t == Type::Array && i < arr.size() ? arr[i] : nullValue(); }

            std::string asString (const std::string& def = {}) const
            {
                switch (t)
                {
                    case Type::String: return str;
                    case Type::Number: { std::string s; dumpNumber (s, number); return s; }
                    case Type::Bool: return boolean ? "true" : "false";
                    default: return def;
                }
            }
            double asDouble (double def = 0) const
            {
                switch (t)
                {
                    case Type::Number: return number;
                    case Type::Bool: return boolean ? 1.0 : 0.0;
                    case Type::String:
                    {
                        char* end = nullptr;
                        const double d = std::strtod (str.c_str(), &end);
                        return end != str.c_str() ? d : def;
                    }
                    default: return def;
                }
            }
            int64_t asInt64 (int64_t def = 0) const
            {
                if (t == Type::Number || t == Type::Bool || t == Type::String)
                {
                    const double d = asDouble (std::nan (""));
                    return std::isnan (d) ? def : (int64_t) d;
                }
                return def;
            }
            int asInt (int def = 0) const { return (int) asInt64 (def); }
            bool asBool (bool def = false) const
            {
                switch (t)
                {
                    case Type::Bool: return boolean;
                    case Type::Number: return number != 0;
                    case Type::String: return str == "true" || str == "1";
                    default: return def;
                }
            }

            std::string dump() const { std::string s; dumpTo (s); return s; }

            static Value parse (const std::string& text, std::string* error = nullptr)
            {
                Parser p { text.data(), text.data() + text.size(), {} };
                Value v;
                p.ws();
                if (! p.value (v, 0)) { if (error) *error = p.err; return {}; }
                p.ws();
                if (p.c != p.e) { if (error) *error = "caractères en trop"; return {}; }
                return v;
            }

        private:
            Type t = Type::Null;
            bool boolean = false;
            double number = 0;
            std::string str;
            std::vector<Value> arr;
            std::vector<std::pair<std::string, Value>> obj;

            static const Value& nullValue() { static const Value n; return n; }

            static void dumpNumber (std::string& s, double d)
            {
                if (! std::isfinite (d)) { s += "null"; return; }
                char buf[40];
                if (d == std::floor (d) && std::abs (d) < 1e15) std::snprintf (buf, sizeof (buf), "%lld", (long long) d);
                else std::snprintf (buf, sizeof (buf), "%.17g", d);
                s += buf;
            }

            static void dumpString (std::string& s, const std::string& v)
            {
                s.push_back ('"');
                for (unsigned char c : v)
                {
                    switch (c)
                    {
                        case '"': s += "\\\""; break;
                        case '\\': s += "\\\\"; break;
                        case '\b': s += "\\b"; break;
                        case '\f': s += "\\f"; break;
                        case '\n': s += "\\n"; break;
                        case '\r': s += "\\r"; break;
                        case '\t': s += "\\t"; break;
                        default:
                            if (c < 0x20) { char b[8]; std::snprintf (b, sizeof (b), "\\u%04x", c); s += b; }
                            else s.push_back ((char) c);
                    }
                }
                s.push_back ('"');
            }

            void dumpTo (std::string& s) const
            {
                switch (t)
                {
                    case Type::Null: s += "null"; break;
                    case Type::Bool: s += boolean ? "true" : "false"; break;
                    case Type::Number: dumpNumber (s, number); break;
                    case Type::String: dumpString (s, str); break;
                    case Type::Array:
                        s.push_back ('[');
                        for (size_t i = 0; i < arr.size(); ++i) { if (i) s.push_back (','); arr[i].dumpTo (s); }
                        s.push_back (']');
                        break;
                    case Type::Object:
                        s.push_back ('{');
                        for (size_t i = 0; i < obj.size(); ++i)
                        {
                            if (i) s.push_back (',');
                            dumpString (s, obj[i].first);
                            s.push_back (':');
                            obj[i].second.dumpTo (s);
                        }
                        s.push_back ('}');
                        break;
                }
            }

            struct Parser
            {
                const char* c;
                const char* e;
                std::string err;

                void ws() { while (c < e && (*c == ' ' || *c == '\t' || *c == '\n' || *c == '\r')) ++c; }
                bool fail (const char* m) { if (err.empty()) err = m; return false; }
                bool lit (const char* w)
                {
                    const char* p = c;
                    for (; *w; ++w, ++p) if (p >= e || *p != *w) return false;
                    c = p;
                    return true;
                }

                static void utf8 (std::string& s, uint32_t cp)
                {
                    if (cp < 0x80) s.push_back ((char) cp);
                    else if (cp < 0x800) { s.push_back ((char) (0xC0 | (cp >> 6))); s.push_back ((char) (0x80 | (cp & 0x3F))); }
                    else if (cp < 0x10000)
                    {
                        s.push_back ((char) (0xE0 | (cp >> 12))); s.push_back ((char) (0x80 | ((cp >> 6) & 0x3F)));
                        s.push_back ((char) (0x80 | (cp & 0x3F)));
                    }
                    else
                    {
                        s.push_back ((char) (0xF0 | (cp >> 18))); s.push_back ((char) (0x80 | ((cp >> 12) & 0x3F)));
                        s.push_back ((char) (0x80 | ((cp >> 6) & 0x3F))); s.push_back ((char) (0x80 | (cp & 0x3F)));
                    }
                }

                bool hex4 (uint32_t& out)
                {
                    if (e - c < 4) return fail ("échappement \\u incomplet");
                    out = 0;
                    for (int i = 0; i < 4; ++i, ++c)
                    {
                        const char h = *c;
                        out <<= 4;
                        if (h >= '0' && h <= '9') out |= (uint32_t) (h - '0');
                        else if (h >= 'a' && h <= 'f') out |= (uint32_t) (h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') out |= (uint32_t) (h - 'A' + 10);
                        else return fail ("échappement \\u invalide");
                    }
                    return true;
                }

                bool string (std::string& s)
                {
                    ++c;   // "
                    while (c < e && *c != '"')
                    {
                        if (*c == '\\')
                        {
                            if (++c >= e) return fail ("chaîne incomplète");
                            const char x = *c++;
                            switch (x)
                            {
                                case '"': s.push_back ('"'); break;
                                case '\\': s.push_back ('\\'); break;
                                case '/': s.push_back ('/'); break;
                                case 'b': s.push_back ('\b'); break;
                                case 'f': s.push_back ('\f'); break;
                                case 'n': s.push_back ('\n'); break;
                                case 'r': s.push_back ('\r'); break;
                                case 't': s.push_back ('\t'); break;
                                case 'u':
                                {
                                    uint32_t cp = 0;
                                    if (! hex4 (cp)) return false;
                                    if (cp >= 0xD800 && cp < 0xDC00 && e - c >= 6 && c[0] == '\\' && c[1] == 'u')
                                    {
                                        c += 2;
                                        uint32_t lo = 0;
                                        if (! hex4 (lo)) return false;
                                        if (lo >= 0xDC00 && lo < 0xE000) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                        else { utf8 (s, 0xFFFD); cp = lo; }
                                    }
                                    else if (cp >= 0xD800 && cp < 0xE000) cp = 0xFFFD;
                                    utf8 (s, cp);
                                    break;
                                }
                                default: return fail ("échappement inconnu");
                            }
                        }
                        else s.push_back (*c++);
                    }
                    if (c >= e) return fail ("chaîne non terminée");
                    ++c;
                    return true;
                }

                bool number (double& d)
                {
                    const char* start = c;
                    if (c < e && *c == '-') ++c;
                    while (c < e && ((*c >= '0' && *c <= '9') || *c == '.' || *c == 'e' || *c == 'E' || *c == '+' || *c == '-')) ++c;
                    const std::string tok (start, c);
                    if (tok.empty() || tok == "-") return fail ("nombre invalide");
                    // Point décimal quelle que soit la langue du système.
                    _locale_t loc = _create_locale (LC_NUMERIC, "C");
                    char* end = nullptr;
                    d = _strtod_l (tok.c_str(), &end, loc);
                    _free_locale (loc);
                    if (end == nullptr || *end != '\0') return fail ("nombre invalide");
                    return true;
                }

                bool value (Value& v, int depth)
                {
                    if (depth > 200) return fail ("JSON trop imbriqué");
                    ws();
                    if (c >= e) return fail ("JSON incomplet");
                    switch (*c)
                    {
                        case 'n': if (lit ("null")) { v = Value(); return true; } return fail ("valeur inconnue");
                        case 't': if (lit ("true")) { v = Value (true); return true; } return fail ("valeur inconnue");
                        case 'f': if (lit ("false")) { v = Value (false); return true; } return fail ("valeur inconnue");
                        case '"': { std::string s; if (! string (s)) return false; v = Value (std::move (s)); return true; }
                        case '[':
                        {
                            ++c;
                            v = Value::array();
                            ws();
                            if (c < e && *c == ']') { ++c; return true; }
                            for (;;)
                            {
                                Value item;
                                if (! value (item, depth + 1)) return false;
                                v.arr.push_back (std::move (item));
                                ws();
                                if (c < e && *c == ',') { ++c; continue; }
                                if (c < e && *c == ']') { ++c; return true; }
                                return fail ("tableau mal formé");
                            }
                        }
                        case '{':
                        {
                            ++c;
                            v = Value::object();
                            ws();
                            if (c < e && *c == '}') { ++c; return true; }
                            for (;;)
                            {
                                ws();
                                if (c >= e || *c != '"') return fail ("clé attendue");
                                std::string key;
                                if (! string (key)) return false;
                                ws();
                                if (c >= e || *c != ':') return fail ("« : » attendu");
                                ++c;
                                Value item;
                                if (! value (item, depth + 1)) return false;
                                v.obj.emplace_back (std::move (key), std::move (item));
                                ws();
                                if (c < e && *c == ',') { ++c; continue; }
                                if (c < e && *c == '}') { ++c; return true; }
                                return fail ("objet mal formé");
                            }
                        }
                        default:
                        {
                            double d = 0;
                            if (! number (d)) return false;
                            v = Value (d);
                            return true;
                        }
                    }
                }
            };
        };
    }

    namespace base64
    {
        inline std::string encode (const uint8_t* data, size_t n)
        {
            static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            std::string out;
            out.reserve ((n + 2) / 3 * 4);
            size_t i = 0;
            for (; i + 2 < n; i += 3)
            {
                const uint32_t v = (uint32_t) data[i] << 16 | (uint32_t) data[i + 1] << 8 | data[i + 2];
                out.push_back (tbl[v >> 18]); out.push_back (tbl[(v >> 12) & 63]);
                out.push_back (tbl[(v >> 6) & 63]); out.push_back (tbl[v & 63]);
            }
            if (i < n)
            {
                uint32_t v = (uint32_t) data[i] << 16;
                if (i + 1 < n) v |= (uint32_t) data[i + 1] << 8;
                out.push_back (tbl[v >> 18]); out.push_back (tbl[(v >> 12) & 63]);
                out.push_back (i + 1 < n ? tbl[(v >> 6) & 63] : '=');
                out.push_back ('=');
            }
            return out;
        }

        inline bool decode (const std::string& s, std::vector<uint8_t>& out)
        {
            out.clear();
            out.reserve (s.size() / 4 * 3);
            uint32_t acc = 0;
            int bits = 0;
            for (char ch : s)
            {
                int v;
                if (ch >= 'A' && ch <= 'Z') v = ch - 'A';
                else if (ch >= 'a' && ch <= 'z') v = ch - 'a' + 26;
                else if (ch >= '0' && ch <= '9') v = ch - '0' + 52;
                else if (ch == '+' || ch == '-') v = 62;
                else if (ch == '/' || ch == '_') v = 63;
                else if (ch == '=') break;
                else if (ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') continue;
                else return false;
                acc = (acc << 6) | (uint32_t) v;
                bits += 6;
                if (bits >= 8)
                {
                    bits -= 8;
                    out.push_back ((uint8_t) ((acc >> bits) & 0xFF));
                }
            }
            return true;
        }
    }
}
