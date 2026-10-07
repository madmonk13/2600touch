; 2600Touch demo cart: Snake.
;
; Steer with the joystick; any direction or fire starts. Eat the red food to
; grow and score; the snake speeds up every 5 points. Running into a wall or
; yourself ends the game (the screen flashes); press fire to play again.
; Reset restarts at any time.
;
; The board is 32x16 cells drawn with an asymmetric playfield: every scanline
; writes PF0/PF1/PF2 for the left half, then again mid-line for the right half.
; Each cell is 4 pixels wide and 8 scanlines tall, with a one-line gap between
; rows. The food is missile 0; the score is players 0 and 1.
;
; Build: npm run build:demo

        processor 6502
        include "vcs.h"

ROWS     = 16
ROWBYTES = 5          ; PF1L, PF2L, PF0R, PF1R, PF2R
MINX     = 4          ; playable columns 4..35 (walls at 3 and 36)
MAXX     = 35
MAXLEN   = 60         ; ring holds 64 moves; stop growing a little short
NOFOOD   = $FF

C_SNAKE  = $C8        ; green
C_FOOD   = $44        ; red
C_SCORE  = $0E        ; white
C_DEAD   = $42        ; red flash

; Three full-width wall lines, columns 3-36 (asymmetric playfield).
        MAC WALL
        ldx #3
.wl     sta WSYNC               ;  0
        lda #$80                ;  2
        sta PF0                 ;  5
        lda #$FF                ;  7
        sta PF1                 ; 10  both halves
        sta PF2                 ; 13
        nop                     ; 15
        nop
        nop
        nop
        nop
        nop
        nop                     ; 27
        lda #$F0                ; 29
        sta PF0                 ; 32  right PF0
        nop                     ; 34
        nop
        nop
        nop
        nop
        nop
        nop
        nop                     ; 48
        lda #$1F                ; 50
        sta PF2                 ; 53  right PF2 up to column 36
        dex
        bne .wl
        ENDM

        SEG.U vars
        ORG $80
Grid     ds ROWS*ROWBYTES   ; playfield bytes, ready to write to the TIA
Ring     ds 16              ; snake moves, 2 bits each (0 up, 1 right, 2 down, 3 left)
HeadX    ds 1
HeadY    ds 1
TailX    ds 1
TailY    ds 1
Dir      ds 1               ; direction of the last move
NextDir  ds 1               ; direction for the next move
RingHead ds 1               ; next move slot to write
RingTail ds 1               ; oldest move (the tail's next step)
Len      ds 1
FoodX    ds 1
FoodY    ds 1               ; NOFOOD when none is placed
Score    ds 1               ; BCD
Speed    ds 1               ; frames per move
Timer    ds 1
State    ds 1               ; 0 waiting, 1 playing, 2 dead
DeadT    ds 1
Seed     ds 1
Snd      ds 1
Row      ds 1
Tens     ds 1
Ones     ds 1
Tmp      ds 1
Tmp2     ds 1
Tmp3     ds 1
FoodRow  = Tmp2           ; kernel only: FoodY - 16, matched against Row
FoodOn   = Tmp3           ; kernel only: ENAM0 value for the current row

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
        lda #$5A
        sta Seed
        jsr InitGame

; ---------------------------------------------------------------- frame

Frame
        lda #2
        sta VBLANK
        sta VSYNC
        sta WSYNC
        sta WSYNC
        sta WSYNC
        lda #0
        sta VSYNC
        lda #43
        sta TIM64T

        ; Reset switch restarts.
        lda SWCHB
        lsr
        bcs .noReset
        jsr InitGame
.noReset

        lda State
        beq .waiting
        cmp #1
        beq .playing
        ; Dead: flash for a while, then wait for fire.
        lda DeadT
        beq .deadWait
        dec DeadT
        jmp .logicDone
.deadWait
        lda INPT4
        bmi .logicDone
        jsr InitGame
        jmp .logicDone

.waiting
        jsr Rand                ; stir the seed while the player gets ready
        jsr ReadStick
        bcs .start
        lda INPT4
        bmi .logicDone
.start  lda #1
        sta State
        jmp .logicDone

.playing
        jsr ReadStick
        dec Timer
        bne .logicDone
        lda Speed
        sta Timer
        jsr Step

.logicDone
        lda FoodY
        cmp #NOFOOD
        bne .haveFood
        jsr PlaceFood
.haveFood

        ; Let the current sound effect run out.
        lda Snd
        beq .sndDone
        dec Snd
        bne .sndDone
        lda #0
        sta AUDV0
.sndDone

        ; Score digits: offsets into Digits (8 bytes a glyph), blank leading zero.
        lda Score
        and #$0F
        asl
        asl
        asl
        sta Ones
        lda Score
        and #$F0
        bne .tens
        lda #10*16
.tens   lsr
        sta Tens

        lda FoodY               ; NOFOOD becomes $EF, which no row matches
        sec
        sbc #ROWS
        sta FoodRow

        ; Colors.
        lda DeadT
        and #8
        beq .bk
        lda #C_DEAD
.bk     sta COLUBK
        lda #C_SNAKE
        sta COLUPF
        lda #C_SCORE
        sta COLUP0
        sta COLUP1
        lda #$20                ; missile 0 four pixels wide
        sta NUSIZ0
        lda #0
        sta NUSIZ1
        sta CTRLPF

        ; Positions: score digits side by side, food at its column.
        lda #72
        ldx #0
        jsr PosObject
        lda #80
        ldx #1
        jsr PosObject
        lda FoodX
        asl
        asl
        sec                     ; the missile lands 2 pixels right of a player
        sbc #2
        ldx #2
        jsr PosObject
        sta WSYNC
        sta HMOVE

.waitVBlank
        lda INTIM
        bne .waitVBlank
        sta WSYNC
        lda #0
        sta VBLANK

; ---------------------------------------------------------------- kernel (192 lines)

        ldx #8                  ; 8 blank
.top    sta WSYNC
        dex
        bne .top

        ldx #8                  ; 16 score lines, each glyph row doubled
.score  sta WSYNC
        ldy Tens
        lda Digits,y
        sta GRP0
        ldy Ones
        lda Digits,y
        sta GRP1
        sta WSYNC
        inc Tens
        inc Ones
        dex
        bne .score

        sta WSYNC               ; 6 blank
        lda #0
        sta GRP0
        sta GRP1
        lda #C_FOOD
        sta COLUP0
        ldx #5
.gap    sta WSYNC
        dex
        bne .gap

        WALL                    ; 3 wall lines

        lda #-ROWS              ; 16 rows x 9 lines; Row counts -16..-1 so the
        sta Row                 ; loop ends on a bare inc/bne
.row
        ; Gap line: just the side walls, then pick up this row's bytes.
        sta WSYNC               ;  0
        lda #$80                ;  2
        sta PF0                 ;  5  left wall (column 3)
        lda #0                  ;  7
        sta PF1                 ; 10
        sta PF2                 ; 13
        sta ENAM0               ; 16  no food on gap lines
        ldy Row                 ; 19
        ldx RowOff+ROWS-256,y   ; 23/24
        lda #0                  ; 25/26
        cpy FoodRow             ; 28/29
        bne .noFood             ; 30-32
        lda #2
.noFood sta FoodOn              ; 34-36  shown from the row's first line
        lda #0
        sta PF0                 ; 39-41  right PF0 off
        lda #$10
        nop
        nop
        nop
        nop
        nop
        nop
        sta PF2                 ; 56-58  right wall (column 36)
        ldy #8
.line
        sta WSYNC               ;  0
        lda FoodOn              ;  3
        sta ENAM0               ;  6
        lda #$80                ;  8
        sta PF0                 ; 11  left PF0: the wall
        lda Grid,x              ; 15
        sta PF1                 ; 18  left PF1 (shown from 28)
        lda Grid+1,x            ; 22
        sta PF2                 ; 25  left PF2 (shown from 38.7)
        lda Grid+2,x            ; 29
        sta PF0                 ; 32  right PF0: after 27.7, before 49.3
        nop                     ; 34
        nop                     ; 36
        lda Grid+3,x            ; 40
        sta PF1                 ; 43  right PF1: after 38.7, before 54.7
        nop                     ; 45
        nop                     ; 47
        lda Grid+4,x            ; 51
        sta PF2                 ; 54  right PF2: after 49.3, before 65.3
        dey                     ; 56
        bne .line               ; 59
        inc Row                 ; 64
        bne .row                ; 67
        sty ENAM0               ; 69  (Y is 0)
        WALL                    ; 3 wall lines

        sta WSYNC               ; 12 blank
        lda #0
        sta PF0
        sta PF1
        sta PF2
        ldx #11
.bottom sta WSYNC
        dex
        bne .bottom

; ---------------------------------------------------------------- overscan

        lda #2
        sta VBLANK
        lda #36
        sta TIM64T
.overscan
        lda INTIM
        bne .overscan
        jmp Frame

; ---------------------------------------------------------------- game

InitGame
        ldx #ROWS*ROWBYTES-1
        lda #0
.clr    sta Grid,x
        dex
        bpl .clr
        ldx #4                  ; right wall bit (column 36) in every row
.wall   lda #$10
        sta Grid,x
        txa
        clc
        adc #ROWBYTES
        tax
        cpx #ROWS*ROWBYTES
        bcc .wall

        ; Three segments heading right along row 8.
        lda #8
        sta Tmp
.body   ldx Tmp
        ldy #8
        jsr CellAddr
        ora Grid,x
        sta Grid,x
        inc Tmp
        lda Tmp
        cmp #11
        bne .body
        lda #10
        sta HeadX
        lda #8
        sta HeadY
        sta TailY
        sta TailX
        lda #%0101              ; moves 0 and 1: right, right
        sta Ring
        lda #0
        sta RingTail
        sta Score
        sta State
        sta DeadT
        sta Snd
        sta AUDV0
        lda #2
        sta RingHead
        lda #1
        sta Dir
        sta NextDir
        lda #3
        sta Len
        lda #8
        sta Speed
        sta Timer
        lda #NOFOOD
        sta FoodY
        rts

; Sets NextDir from the joystick. Prefers a turn over going straight, never
; reverses. Carry set if any direction is held.
ReadStick
        lda SWCHA
        eor #$FF
        and #$F0
        sta Tmp3
        beq .none
        ldx #3
.try    lda DirBit,x
        and Tmp3
        beq .next
        txa
        cmp Dir
        beq .next
        eor #2
        cmp Dir
        beq .next
        stx NextDir
        sec
        rts
.next   dex
        bpl .try
        sec
        rts
.none   clc
        rts

; Advance the snake one cell.
Step
        lda NextDir
        sta Dir
        tax
        lda HeadX
        clc
        adc DX,x
        sta Tmp
        lda HeadY
        clc
        adc DY,x
        sta Tmp2
        lda Tmp                 ; walls
        cmp #MINX
        bcc Die
        cmp #MAXX+1
        bcs Die
        lda Tmp2
        cmp #ROWS
        bcs Die

        lda Tmp                 ; food?
        cmp FoodX
        bne .move
        lda Tmp2
        cmp FoodY
        bne .move
        jsr Eat
        lda Len
        cmp #MAXLEN
        bcs .move
        inc Len
        jmp .head               ; grow: the tail stays put

.move   ldx TailX               ; tail leaves its cell
        ldy TailY
        jsr CellAddr
        eor #$FF
        and Grid,x
        sta Grid,x
        jsr RingRead
        tax
        lda TailX
        clc
        adc DX,x
        sta TailX
        lda TailY
        clc
        adc DY,x
        sta TailY
        lda RingTail
        clc
        adc #1
        and #63
        sta RingTail

.head   ldx Tmp                 ; into a cell the snake already fills?
        ldy Tmp2
        jsr CellAddr
        pha
        and Grid,x
        bne .crash
        pla
        ora Grid,x
        sta Grid,x
        lda Tmp
        sta HeadX
        lda Tmp2
        sta HeadY
        jmp RingWrite           ; records Dir and returns
.crash  pla
Die
        lda #2
        sta State
        lda #90
        sta DeadT
        lda #8
        sta AUDC0
        lda #24
        sta AUDF0
        lda #14
        sta AUDV0
        lda #40
        sta Snd
        rts

Eat
        lda #NOFOOD
        sta FoodY
        lda Score
        cmp #$99
        beq .beep
        sed
        clc
        adc #1
        cld
        sta Score
        and #$0F                ; faster every 5 points, down to 3 frames a move
        beq .faster
        cmp #5
        bne .beep
.faster lda Speed
        cmp #3
        beq .beep
        dec Speed
.beep   lda #4
        sta AUDC0
        lda #6
        sta AUDF0
        lda #10
        sta AUDV0
        lda #6
        sta Snd
        rts

; Put food on a random empty cell; a few tries per frame.
PlaceFood
        lda #6
        sta Row
.again  jsr Rand
        and #31
        clc
        adc #MINX
        sta FoodX
        jsr Rand
        jsr Rand
        and #ROWS-1
        sta FoodY
        ldx FoodX
        ldy FoodY
        jsr CellAddr
        and Grid,x
        beq .placed
        dec Row
        bne .again
        lda #NOFOOD
        sta FoodY
.placed rts

; X = column, Y = row  ->  X = Grid index, A = bit mask.
CellAddr
        lda RowOff,y
        clc
        adc ColByte,x
        sta Tmp3
        lda ColMask,x
        ldx Tmp3
        rts

; Store Dir in the move ring at RingHead and advance it.
RingWrite
        lda RingHead
        lsr
        lsr
        tax
        lda RingHead
        and #3
        tay
        lda Ring,x
        and RingClr,y
        sta Tmp3
        tya
        asl
        asl
        ora Dir
        tay
        lda DirShift,y
        ora Tmp3
        sta Ring,x
        lda RingHead
        clc
        adc #1
        and #63
        sta RingHead
        rts

; A = the move stored at RingTail.
RingRead
        lda RingTail
        lsr
        lsr
        tax
        lda RingTail
        and #3
        tay
        lda Ring,x
        cpy #0
        beq .got
.shift  lsr
        lsr
        dey
        bne .shift
.got    and #3
        rts

Rand
        lda Seed
        lsr
        bcc .noEor
        eor #$B4
.noEor  sta Seed
        rts

; A = x (0-159), X = object (0 P0, 1 P1, 2 M0, 3 M1, 4 BL). Uses one line.
PosObject
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

; ---------------------------------------------------------------- tables

DX      .byte 0, 1, 0, $FF
DY      .byte $FF, 0, 1, 0
DirBit  .byte $10, $80, $20, $40        ; SWCHA bits for up, right, down, left
RingClr .byte $FC, $F3, $CF, $3F
DirShift
        .byte 0, 1, 2, 3
        .byte 0, 4, 8, 12
        .byte 0, 16, 32, 48
        .byte 0, 64, 128, 192

RowOff
        .byte 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75

; Column -> byte within a row and bit within that byte, matching how the TIA
; scans each register: PF1 high bit first, PF2 and PF0 low bit first.
ColByte
        .byte 0, 0, 0, 0                                ; 0-3: left PF0 (wall only)
        .byte 0, 0, 0, 0, 0, 0, 0, 0                    ; 4-11: PF1 left
        .byte 1, 1, 1, 1, 1, 1, 1, 1                    ; 12-19: PF2 left
        .byte 2, 2, 2, 2                                ; 20-23: PF0 right
        .byte 3, 3, 3, 3, 3, 3, 3, 3                    ; 24-31: PF1 right
        .byte 4, 4, 4, 4, 4, 4, 4, 4                    ; 32-39: PF2 right
ColMask
        .byte 0, 0, 0, 0
        .byte $80, $40, $20, $10, $08, $04, $02, $01
        .byte $01, $02, $04, $08, $10, $20, $40, $80
        .byte $10, $20, $40, $80
        .byte $80, $40, $20, $10, $08, $04, $02, $01
        .byte $01, $02, $04, $08, $10, $20, $40, $80

Digits
        .byte %00111100, %01100110, %01101110, %01110110, %01100110, %01100110, %00111100, 0 ; 0
        .byte %00011000, %00111000, %00011000, %00011000, %00011000, %00011000, %00111100, 0 ; 1
        .byte %00111100, %01100110, %00000110, %00001100, %00110000, %01100000, %01111110, 0 ; 2
        .byte %00111100, %01100110, %00000110, %00011100, %00000110, %01100110, %00111100, 0 ; 3
        .byte %00001100, %00011100, %00101100, %01001100, %01111110, %00001100, %00001100, 0 ; 4
        .byte %01111110, %01100000, %01111100, %00000110, %00000110, %01100110, %00111100, 0 ; 5
        .byte %00111100, %01100000, %01111100, %01100110, %01100110, %01100110, %00111100, 0 ; 6
        .byte %01111110, %00000110, %00001100, %00011000, %00110000, %00110000, %00110000, 0 ; 7
        .byte %00111100, %01100110, %01100110, %00111100, %01100110, %01100110, %00111100, 0 ; 8
        .byte %00111100, %01100110, %01100110, %00111110, %00000110, %00001100, %00111000, 0 ; 9
        .byte 0, 0, 0, 0, 0, 0, 0, 0                                                        ; blank

        ORG $FFFC
        .word Reset
        .word Reset
