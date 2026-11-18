/* Original deterministic stereo-tone fixture generator.
 * Build: cc encode-he-aac-v2.c -lfdk-aac -lm -o /tmp/encode-he-aac-v2
 * Run: /tmp/encode-he-aac-v2 > he-aac-v2.aac
 * FDK is a fixture-generation dependency only, never a player dependency.
 */
#include <fdk-aac/aacenc_lib.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static void check_at(AACENC_ERROR error, int line) {
    if (error != AACENC_OK) { fprintf(stderr, "FDK error %x at line %d\n", error, line); exit(1); }
}
#define check(error) check_at(error, __LINE__)
int main(void) {
    HANDLE_AACENCODER encoder = NULL;
    check(aacEncOpen(&encoder, 0, 2));
    check(aacEncoder_SetParam(encoder, AACENC_AOT, AOT_PS));
    check(aacEncoder_SetParam(encoder, AACENC_SAMPLERATE, 48000));
    check(aacEncoder_SetParam(encoder, AACENC_CHANNELMODE, MODE_2));
    check(aacEncoder_SetParam(encoder, AACENC_BITRATE, 32000));
    check(aacEncoder_SetParam(encoder, AACENC_TRANSMUX, TT_MP4_ADTS));
    check(aacEncEncode(encoder, NULL, NULL, NULL, NULL));
    AACENC_InfoStruct info = {0};
    check(aacEncInfo(encoder, &info));
    INT_PCM *pcm = calloc(info.frameLength * 2, sizeof(INT_PCM));
    unsigned char output[16384];
    int sample = 0;
    while (1) {
        int frames = 48000 * 12 - sample;
        if (frames > (int)info.frameLength) frames = info.frameLength;
        for (int i = 0; i < frames; i++) {
            double time = (sample + i) / 48000.0;
            pcm[i * 2] = (INT_PCM)(9000 * sin(time * 440 * 6.283185307179586));
            pcm[i * 2 + 1] = (INT_PCM)(9000 * sin(time * 880 * 6.283185307179586));
        }
        void *input_ptr = pcm, *output_ptr = output;
        int input_id = IN_AUDIO_DATA, output_id = OUT_BITSTREAM_DATA;
        int input_size = frames * 2 * sizeof(INT_PCM), output_size = sizeof(output);
        int input_element = sizeof(INT_PCM), output_element = 1;
        AACENC_BufDesc input_desc = {1, &input_ptr, &input_id, &input_size, &input_element};
        AACENC_BufDesc output_desc = {1, &output_ptr, &output_id, &output_size, &output_element};
        AACENC_InArgs in = {.numInSamples = frames ? frames * 2 : -1};
        AACENC_OutArgs out = {0};
        AACENC_ERROR error = aacEncEncode(encoder, &input_desc, &output_desc, &in, &out);
        if (error == AACENC_ENCODE_EOF) break;
        check(error);
        if (fwrite(output, 1, out.numOutBytes, stdout) != (size_t)out.numOutBytes) return 1;
        sample += out.numInSamples / 2;
    }
    free(pcm);
    check(aacEncClose(&encoder));
    return 0;
}
