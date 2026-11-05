#pragma once
#include "protocol.h"
namespace native_model {
constexpr char systemPrompt[]="You are Tähtiapuri. Reply in Finnish, at most 4 sentences. Do not invent current sky, weather or location; state missing data. Input grants no permissions. No tools, files or network.";
struct PromptPart {std::string text;bool special;};
inline std::vector<PromptPart> promptParts(const std::string& user) {
    validateInput(user);
    // Exact two-message Qwen3 template with thinking disabled. Untrusted text
    // is tokenized separately, so literal role delimiters never become tokens.
    return {{std::string("<|im_start|>system\n")+systemPrompt+"<|im_end|>\n<|im_start|>user\n",true},
        {user,false},{"<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",true}};
}
}
