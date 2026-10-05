; 2600Touch demo cart — a small playable scene that exercises every TIA object:
;   playfield maze (reflected), player 0 (you), player 1 (double-size alien),
;   missile 0 (your shot), ball (bouncing), per-line background colors.
;
; Controls: joystick moves, fire shoots. Hitting the alien flashes the maze.
;
; Build: npm run build:demo

        processor 6502
        include "vcs.h"

SPRITE_H = 8          ; sprite height in line-pairs
M0_OFF   = 200        ; M0Y value meaning "no missile"

        SEG.U vars
        ORG $80
P0X     ds 1
P0Y     ds 1
OldX    ds 1
OldY    ds 1
P1X     ds 1
P1Y     ds 1
P1DX    ds 1
P1DY    ds 1
BLX     ds 1
BLY     ds 1
BLDX    ds 1
BLDY    ds 1
M0X     ds 1
M0Y     ds 1
M0DX    ds 1
Facing  ds 1
Frame   ds 1
Tmp0    ds 1
Tmp1    ds 1
P0Cnt   ds 1
P1Cnt   ds 1
P0Ptr   ds 2
P1Ptr   ds 2
Score   ds 1
HitTime ds 1

        SEG code
        ORG $F000

Reset
        sei
        cld
        ldx #0
        txa
.clear  dex
        txs
        pha
        bne .clear

        lda #24
        sta P0X
        lda #10
        sta P0Y
        lda #100
        sta P1X
        lda #60
        sta P1Y
        lda #1
        sta P1DX
        sta P1DY
        sta BLDY
        lda #80
        sta BLX
        lda #40
        sta BLY
        lda #$FF
        sta BLDX
        lda #M0_OFF
        sta M0Y

        lda #$21            ; reflected playfield, 4-pixel ball
        sta CTRLPF
        lda #$20            ; 4-pixel missile 0
        sta NUSIZ0
        lda #$05            ; double-size player 1
        sta NUSIZ1

;---------------------------------------------------------------- frame
MainLoop
        lda #2
        sta WSYNC
        sta VSYNC
        sta WSYNC
        sta WSYNC
        sta WSYNC
        lda #0
        sta VSYNC
        lda #43
        sta TIM64T

        inc Frame
        jsr Joystick
        jsr MoveP1
        jsr MoveBall
        jsr MoveMissile

        ; colors
        lda #$1E
        sta COLUP0
        lda Frame
        asl
        asl
        and #$F0
        ora #$08
        sta COLUP1
        lda HitTime
        beq .calm
        dec HitTime
        lda #$0E
        bne .setpf
.calm   lda #$66
.setpf  sta COLUPF

        ; horizontal positions
        ldx #0
        lda P0X
        jsr PosObject
        ldx #1
        lda P1X
        jsr PosObject
        ldx #2
        lda M0X
        jsr PosObject
        ldx #4
        lda BLX
        jsr PosObject
        sta WSYNC
        sta HMOVE

        ; sprite pointers / skip-draw counters
        lda #<ManGfx
        sec
        sbc P0Y
        sta P0Ptr
        lda #>ManGfx
        sbc #0
        sta P0Ptr+1
        lda #<AlienGfx
        sec
        sbc P1Y
        sta P1Ptr
        lda #>AlienGfx
        sbc #0
        sta P1Ptr+1
        lda #95
        sec
        sbc P0Y
        sta P0Cnt
        lda #95
        sec
        sbc P1Y
        sta P1Cnt
        lda #0
        sta Tmp0
        sta Tmp1
        ldy #95

.vbwait lda INTIM
        bne .vbwait
        sta VBLANK

;---------------------------------------------------------------- kernel
; Two scanlines per iteration, Y = line-pair (95 at top, 0 at bottom).
KLoop
        sta WSYNC
        ; ---- line A: sprites, background, ball, missile
        lda BkTab,y         ; 4
        sta COLUBK          ; 3
        lda Tmp0            ; 3
        sta GRP0            ; 3
        lda Tmp1            ; 3
        sta GRP1            ; 3   19
        tya                 ; 2
        lsr                 ; 2
        lsr                 ; 2
        tax                 ; 2   27  X = playfield row
        tya
        sec
        sbc BLY
        cmp #3
        lda #0
        bcs .nobl
        lda #2
.nobl   sta ENABL           ;     45
        tya
        sec
        sbc M0Y
        cmp #2
        lda #0
        bcs .nom0
        lda #2
.nom0   sta ENAM0           ;     63

        sta WSYNC
        ; ---- line B: playfield, then next pair's sprite rows
        lda PF0Tab,x        ; 4
        sta PF0             ; 3
        lda PF1Tab,x        ; 4
        sta PF1             ; 3
        lda PF2Tab,x        ; 4
        sta PF2             ; 3   21
        dey                 ; 2   23
        lda #SPRITE_H-1     ; 2
        dcp P0Cnt           ; 5
        bcs .draw0          ; 2/3
        lda #0              ; 2
        .byte $2C           ; 4   (BIT abs: skips next instruction)
.draw0  lda (P0Ptr),y       ; 5/6
        sta Tmp0            ; 3   ~42
        lda #SPRITE_H-1
        dcp P1Cnt
        bcs .draw1
        lda #0
        .byte $2C
.draw1  lda (P1Ptr),y
        sta Tmp1            ;     ~61
        tya                 ; 2
        bpl KLoop           ; 3   ~66

;---------------------------------------------------------------- overscan
        sta WSYNC
        lda #2
        sta VBLANK
        lda #0
        sta GRP0
        sta GRP1
        sta ENABL
        sta ENAM0
        sta PF0
        sta PF1
        sta PF2
        lda #35
        sta TIM64T

        bit CXP0FB          ; player 0 hit a wall? undo the move
        bpl .noWall
        lda OldX
        sta P0X
        lda OldY
        sta P0Y
.noWall
        bit CXM0P           ; shot hit the alien
        bpl .noShot
        lda Frame
        and #$7F
        clc
        adc #8
        sta P1X
        lda #80
        sta P1Y
        lda #M0_OFF
        sta M0Y
        lda #24
        sta HitTime
        sed
        lda Score
        clc
        adc #1
        sta Score
        cld
.noShot
        bit CXPPMM          ; touching the alien
        bpl .noTouch
        lda HitTime
        bne .noTouch
        lda #6
        sta HitTime
.noTouch
        sta CXCLR

.oswait lda INTIM
        bne .oswait
        jmp MainLoop

;---------------------------------------------------------------- subroutines
; A = x position, X = object (0=P0 1=P1 2=M0 3=M1 4=BL)
PosObject  SUBROUTINE
        sta WSYNC
        sec
.div    sbc #15
        bcs .div
        eor #7
        asl
        asl
        asl
        asl
        sta HMP0,x
        sta RESP0,x
        rts

Joystick  SUBROUTINE
        lda P0X
        sta OldX
        lda P0Y
        sta OldY
        ldx SWCHA
        txa
        and #$80
        bne .noR
        inc P0X
        lda #0
        sta Facing
.noR    txa
        and #$40
        bne .noL
        dec P0X
        lda #8
        sta Facing
.noL    txa
        and #$20
        bne .noD
        dec P0Y
.noD    txa
        and #$10
        bne .noU
        inc P0Y
.noU
        lda Facing
        sta REFP0
        lda INPT4
        bmi .noFire
        lda M0Y
        cmp #M0_OFF
        bne .noFire
        lda P0Y
        clc
        adc #3
        sta M0Y
        lda P0X
        clc
        adc #2
        sta M0X
        lda Facing
        beq .fireR
        lda #$FD
        bne .setDX
.fireR  lda #3
.setDX  sta M0DX
.noFire rts

MoveP1  SUBROUTINE
        lda P1X
        clc
        adc P1DX
        sta P1X
        cmp #8
        bcc .flipX
        cmp #136
        bcc .xok
.flipX  lda #0
        sec
        sbc P1DX
        sta P1DX
.xok    lda P1Y
        clc
        adc P1DY
        sta P1Y
        cmp #2
        bcc .flipY
        cmp #86
        bcc .yok
.flipY  lda #0
        sec
        sbc P1DY
        sta P1DY
.yok    rts

MoveBall  SUBROUTINE
        lda BLX
        clc
        adc BLDX
        sta BLX
        cmp #4
        bcc .flipX
        cmp #152
        bcc .xok
.flipX  lda #0
        sec
        sbc BLDX
        sta BLDX
.xok    lda BLY
        clc
        adc BLDY
        sta BLY
        cmp #2
        bcc .flipY
        cmp #92
        bcc .yok
.flipY  lda #0
        sec
        sbc BLDY
        sta BLDY
.yok    rts

MoveMissile  SUBROUTINE
        lda M0Y
        cmp #M0_OFF
        beq .done
        lda M0X
        clc
        adc M0DX
        sta M0X
        cmp #4
        bcc .kill
        cmp #154
        bcc .done
.kill   lda #M0_OFF
        sta M0Y
.done   rts

;---------------------------------------------------------------- data
        ALIGN 256
        include "demo-tables.inc"

; Sprites are stored bottom row first (the kernel counts Y downward).
ManGfx
        .byte %01100110
        .byte %00100100
        .byte %00111100
        .byte %00111100
        .byte %01111110
        .byte %00011000
        .byte %00111100
        .byte %00111100
AlienGfx
        .byte %10000001
        .byte %01011010
        .byte %11111111
        .byte %11011011
        .byte %01111110
        .byte %00111100
        .byte %00100100
        .byte %01000010

        ORG $FFFC
        .word Reset
        .word Reset
