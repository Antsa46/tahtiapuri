#pragma once
// Fixed synthetic Qwen3 fixture; rendered from the pinned GGUF template with thinking disabled.
namespace native_model {
constexpr char prompt[]="<|im_start|>system\nVastaa lyhyesti suomeksi.<|im_end|>\n<|im_start|>user\nVastaa vain yhdellä sanalla: Jupiter<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";
constexpr char templateHash[]="57f1fd00f0013a2be96aa79b857391f27e23df5b5f847072b524c897e24d0361";
}
