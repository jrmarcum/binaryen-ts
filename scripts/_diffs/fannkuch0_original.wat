(module
 (type $0 (func (param i32) (result i32)))
 (type $1 (func (param i32 i32) (result i32)))
 (type $2 (func (param i32)))
 (type $3 (func))
 (import "env" "memory" (memory $mimport$0 256 256))
 (import "env" "__indirect_function_table" (table $timport$0 1 funcref))
 (import "env" "malloc" (func $malloc (type $0) (param i32) (result i32)))
 (import "env" "free" (func $free (type $2) (param i32)))
 (import "env" "atoi" (func $atoi (type $0) (param i32) (result i32)))
 (import "env" "printf" (func $printf (type $1) (param i32 i32) (result i32)))
 (global $global$0 (mut i32) (i32.const 5243952))
 (global $global$1 i32 (i32.const 1069))
 (data $0 (i32.const 1024) "Wrong argument.\n\00Pfannkuchen(%d) = %d.\n\00%d\00\n\00")
 (export "__wasm_call_ctors" (func $__wasm_call_ctors))
 (export "main" (func $main))
 (export "__data_end" (global $global$1))
 (func $__wasm_call_ctors (type $3)
 )
 (func $fannkuch_worker\28void*\29 (type $0) (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 i32)
  (local $19 i32)
  (local $20 i32)
  (local $21 i32)
  (local $22 i32)
  (local $23 i32)
  (local $24 i32)
  (local $25 i32)
  (local $26 i32)
  (local $27 i32)
  (local $28 i32)
  (local $29 i32)
  (local $30 i32)
  (local $31 i32)
  (local $32 i32)
  (local $33 i32)
  (local $34 i32)
  (local $35 i32)
  (local $36 i32)
  (local $37 i32)
  (local $38 i32)
  (local $39 i32)
  (local $40 i32)
  (local $41 i32)
  (local $42 i32)
  (local $43 i32)
  (local $44 i32)
  (local $45 i32)
  (local $46 i32)
  (local $47 i32)
  (local $48 i32)
  (local $49 i32)
  (local $50 i32)
  (local $51 i32)
  (local $52 i32)
  (local $53 i32)
  (local $54 i32)
  (local $55 i32)
  (local $56 i32)
  (local $57 i32)
  (local $58 i32)
  (local $59 i32)
  (local $60 i32)
  (local $61 i32)
  (local $62 i32)
  (local $63 i32)
  (local $64 i32)
  (local $65 i32)
  (local $66 i32)
  (local $67 i32)
  (local $68 i32)
  (local $69 i32)
  (local $70 i32)
  (local $71 i32)
  (local $72 i32)
  (local $73 i32)
  (local $74 i32)
  (local $75 i32)
  (local $76 i32)
  (local $77 i32)
  (local $78 i32)
  (local $79 i32)
  (local $80 i32)
  (local $81 i32)
  (local $82 i32)
  (local $83 i32)
  (local $84 i32)
  (local $85 i32)
  (local $86 i32)
  (local $87 i32)
  (local $88 i32)
  (local $89 i32)
  (local $90 i32)
  (local $91 i32)
  (local $92 i32)
  (local $93 i32)
  (local $94 i32)
  (local $95 i32)
  (local $96 i32)
  (local $97 i32)
  (local $98 i32)
  (local $99 i32)
  (local $100 i32)
  (local $101 i32)
  (local $102 i32)
  (local $103 i32)
  (local $104 i32)
  (local $105 i32)
  (local $106 i32)
  (local $107 i32)
  (local $108 i32)
  (local $109 i32)
  (local $110 i32)
  (local $111 i32)
  (local $112 i32)
  (local $113 i32)
  (local $114 i32)
  (local $115 i32)
  (local $116 i32)
  (local $117 i32)
  (local $118 i32)
  (local $119 i32)
  (local $120 i32)
  (local $121 i32)
  (local $122 i32)
  (local $123 i32)
  (local $124 i32)
  (local $125 i32)
  (local $126 i32)
  (local $127 i32)
  (local $128 i32)
  (local $129 i32)
  (local $130 i32)
  (local $131 i32)
  (local $132 i32)
  (local $133 i32)
  (local $134 i32)
  (local $135 i32)
  (local $136 i32)
  (local $137 i32)
  (local $138 i32)
  (local $139 i32)
  (local $140 i32)
  (local $141 i32)
  (local $142 i32)
  (local $143 i32)
  (local $144 i32)
  (local $145 i32)
  (local $146 i32)
  (local $147 i32)
  (local $148 i32)
  (local $149 i32)
  (local $150 i32)
  (local $151 i32)
  (local $152 i32)
  (local $153 i32)
  (local $154 i32)
  (local $155 i32)
  (local $156 i32)
  (local $157 i32)
  (local $158 i32)
  (local $159 i32)
  (local $160 i32)
  (local $161 i32)
  (local $162 i32)
  (local $163 i32)
  (local $164 i32)
  (local $165 i32)
  (local $166 i32)
  (local $167 i32)
  (local $168 i32)
  (local $169 i32)
  (local $170 i32)
  (local $171 i32)
  (local $172 i32)
  (local $173 i32)
  (local $174 i32)
  (local $175 i32)
  (local $176 i32)
  (local $177 i32)
  (local $178 i32)
  (local $179 i32)
  (local $180 i32)
  (local $181 i32)
  (local $182 i32)
  (local $183 i32)
  (local $184 i32)
  (local $185 i32)
  (local $186 i32)
  (local $187 i32)
  (local $188 i32)
  (local $189 i32)
  (local $190 i32)
  (local $191 i32)
  (local $192 i32)
  (local $193 i32)
  (local $194 i32)
  (local $195 i32)
  (local $196 i32)
  (local $197 i32)
  (local $198 i32)
  (local $199 i32)
  (local $200 i32)
  (local $201 i32)
  (local $202 i32)
  (local $203 i32)
  (local $204 i32)
  (local $205 i32)
  (local $206 i32)
  (local $207 i32)
  (local $208 i32)
  (local $209 i32)
  (local $210 i32)
  (local $211 i32)
  (local $212 i32)
  (local $213 i32)
  (local $214 i32)
  (local $215 i32)
  (local $216 i32)
  (local $217 i32)
  (local $218 i32)
  (local $219 i32)
  (local $220 i32)
  (local $221 i32)
  (local $222 i32)
  (local $223 i32)
  (local $224 i32)
  (local $225 i32)
  (local $226 i32)
  (local $227 i32)
  (local $228 i32)
  (local $229 i32)
  (local $230 i32)
  (local $231 i32)
  (local $232 i32)
  (local $233 i32)
  (local $234 i32)
  (local $235 i32)
  (local $236 i32)
  (local $237 i32)
  (local $238 i32)
  (local $239 i32)
  (local $240 i32)
  (local $241 i32)
  (local $242 i32)
  (local $243 i32)
  (local $244 i32)
  (local.set $1
   (global.get $global$0)
  )
  (local.set $2
   (i32.const 64)
  )
  (local.set $3
   (i32.sub
    (local.get $1)
    (local.get $2)
   )
  )
  (global.set $global$0
   (local.get $3)
  )
  (local.set $4
   (i32.const 0)
  )
  (i32.store offset=60
   (local.get $3)
   (local.get $0)
  )
  (local.set $5
   (i32.load offset=60
    (local.get $3)
   )
  )
  (i32.store offset=56
   (local.get $3)
   (local.get $5)
  )
  (i32.store offset=40
   (local.get $3)
   (local.get $4)
  )
  (local.set $6
   (i32.load offset=56
    (local.get $3)
   )
  )
  (local.set $7
   (i32.load offset=4
    (local.get $6)
   )
  )
  (i32.store offset=28
   (local.get $3)
   (local.get $7)
  )
  (local.set $8
   (i32.load offset=28
    (local.get $3)
   )
  )
  (local.set $9
   (i32.const 2)
  )
  (local.set $10
   (i32.shl
    (local.get $8)
    (local.get $9)
   )
  )
  (local.set $11
   (call $malloc
    (local.get $10)
   )
  )
  (i32.store offset=52
   (local.get $3)
   (local.get $11)
  )
  (local.set $12
   (i32.load offset=28
    (local.get $3)
   )
  )
  (local.set $13
   (i32.const 2)
  )
  (local.set $14
   (i32.shl
    (local.get $12)
    (local.get $13)
   )
  )
  (local.set $15
   (call $malloc
    (local.get $14)
   )
  )
  (i32.store offset=44
   (local.get $3)
   (local.get $15)
  )
  (local.set $16
   (i32.load offset=28
    (local.get $3)
   )
  )
  (local.set $17
   (i32.const 2)
  )
  (local.set $18
   (i32.shl
    (local.get $16)
    (local.get $17)
   )
  )
  (local.set $19
   (call $malloc
    (local.get $18)
   )
  )
  (i32.store offset=48
   (local.get $3)
   (local.get $19)
  )
  (i32.store offset=32
   (local.get $3)
   (local.get $4)
  )
  (block $label$1
   (loop $label$2
    (local.set $20
     (i32.load offset=32
      (local.get $3)
     )
    )
    (local.set $21
     (i32.load offset=28
      (local.get $3)
     )
    )
    (local.set $22
     (local.get $20)
    )
    (local.set $23
     (local.get $21)
    )
    (local.set $24
     (i32.lt_s
      (local.get $22)
      (local.get $23)
     )
    )
    (local.set $25
     (i32.const 1)
    )
    (local.set $26
     (i32.and
      (local.get $24)
      (local.get $25)
     )
    )
    (br_if $label$1
     (i32.eqz
      (local.get $26)
     )
    )
    (local.set $27
     (i32.load offset=32
      (local.get $3)
     )
    )
    (local.set $28
     (i32.load offset=52
      (local.get $3)
     )
    )
    (local.set $29
     (i32.load offset=32
      (local.get $3)
     )
    )
    (local.set $30
     (i32.const 2)
    )
    (local.set $31
     (i32.shl
      (local.get $29)
      (local.get $30)
     )
    )
    (local.set $32
     (i32.add
      (local.get $28)
      (local.get $31)
     )
    )
    (i32.store
     (local.get $32)
     (local.get $27)
    )
    (local.set $33
     (i32.load offset=32
      (local.get $3)
     )
    )
    (local.set $34
     (i32.const 1)
    )
    (local.set $35
     (i32.add
      (local.get $33)
      (local.get $34)
     )
    )
    (i32.store offset=32
     (local.get $3)
     (local.get $35)
    )
    (br $label$2)
   )
  )
  (local.set $36
   (i32.load offset=28
    (local.get $3)
   )
  )
  (local.set $37
   (i32.const 1)
  )
  (local.set $38
   (i32.sub
    (local.get $36)
    (local.get $37)
   )
  )
  (local.set $39
   (i32.load offset=52
    (local.get $3)
   )
  )
  (local.set $40
   (i32.load offset=56
    (local.get $3)
   )
  )
  (local.set $41
   (i32.load
    (local.get $40)
   )
  )
  (local.set $42
   (i32.const 2)
  )
  (local.set $43
   (i32.shl
    (local.get $41)
    (local.get $42)
   )
  )
  (local.set $44
   (i32.add
    (local.get $39)
    (local.get $43)
   )
  )
  (i32.store
   (local.get $44)
   (local.get $38)
  )
  (local.set $45
   (i32.load offset=56
    (local.get $3)
   )
  )
  (local.set $46
   (i32.load
    (local.get $45)
   )
  )
  (local.set $47
   (i32.load offset=52
    (local.get $3)
   )
  )
  (local.set $48
   (i32.load offset=28
    (local.get $3)
   )
  )
  (local.set $49
   (i32.const 1)
  )
  (local.set $50
   (i32.sub
    (local.get $48)
    (local.get $49)
   )
  )
  (local.set $51
   (i32.const 2)
  )
  (local.set $52
   (i32.shl
    (local.get $50)
    (local.get $51)
   )
  )
  (local.set $53
   (i32.add
    (local.get $47)
    (local.get $52)
   )
  )
  (i32.store
   (local.get $53)
   (local.get $46)
  )
  (local.set $54
   (i32.load offset=28
    (local.get $3)
   )
  )
  (i32.store offset=24
   (local.get $3)
   (local.get $54)
  )
  (loop $label$3 (result i32)
   (block $label$4
    (loop $label$5
     (local.set $55
      (i32.const 1)
     )
     (local.set $56
      (i32.load offset=24
       (local.get $3)
      )
     )
     (local.set $57
      (local.get $56)
     )
     (local.set $58
      (local.get $55)
     )
     (local.set $59
      (i32.gt_s
       (local.get $57)
       (local.get $58)
      )
     )
     (local.set $60
      (i32.const 1)
     )
     (local.set $61
      (i32.and
       (local.get $59)
       (local.get $60)
      )
     )
     (br_if $label$4
      (i32.eqz
       (local.get $61)
      )
     )
     (local.set $62
      (i32.load offset=24
       (local.get $3)
      )
     )
     (local.set $63
      (i32.load offset=48
       (local.get $3)
      )
     )
     (local.set $64
      (i32.load offset=24
       (local.get $3)
      )
     )
     (local.set $65
      (i32.const 1)
     )
     (local.set $66
      (i32.sub
       (local.get $64)
       (local.get $65)
      )
     )
     (local.set $67
      (i32.const 2)
     )
     (local.set $68
      (i32.shl
       (local.get $66)
       (local.get $67)
      )
     )
     (local.set $69
      (i32.add
       (local.get $63)
       (local.get $68)
      )
     )
     (i32.store
      (local.get $69)
      (local.get $62)
     )
     (local.set $70
      (i32.load offset=24
       (local.get $3)
      )
     )
     (local.set $71
      (i32.const -1)
     )
     (local.set $72
      (i32.add
       (local.get $70)
       (local.get $71)
      )
     )
     (i32.store offset=24
      (local.get $3)
      (local.get $72)
     )
     (br $label$5)
    )
   )
   (local.set $73
    (i32.load offset=52
     (local.get $3)
    )
   )
   (local.set $74
    (i32.load
     (local.get $73)
    )
   )
   (block $label$6
    (br_if $label$6
     (i32.eqz
      (local.get $74)
     )
    )
    (local.set $75
     (i32.load offset=52
      (local.get $3)
     )
    )
    (local.set $76
     (i32.load offset=28
      (local.get $3)
     )
    )
    (local.set $77
     (i32.const 1)
    )
    (local.set $78
     (i32.sub
      (local.get $76)
      (local.get $77)
     )
    )
    (local.set $79
     (i32.const 2)
    )
    (local.set $80
     (i32.shl
      (local.get $78)
      (local.get $79)
     )
    )
    (local.set $81
     (i32.add
      (local.get $75)
      (local.get $80)
     )
    )
    (local.set $82
     (i32.load
      (local.get $81)
     )
    )
    (local.set $83
     (i32.load offset=28
      (local.get $3)
     )
    )
    (local.set $84
     (i32.const 1)
    )
    (local.set $85
     (i32.sub
      (local.get $83)
      (local.get $84)
     )
    )
    (local.set $86
     (local.get $82)
    )
    (local.set $87
     (local.get $85)
    )
    (local.set $88
     (i32.ne
      (local.get $86)
      (local.get $87)
     )
    )
    (local.set $89
     (i32.const 1)
    )
    (local.set $90
     (i32.and
      (local.get $88)
      (local.get $89)
     )
    )
    (br_if $label$6
     (i32.eqz
      (local.get $90)
     )
    )
    (local.set $91
     (i32.const 0)
    )
    (i32.store offset=32
     (local.get $3)
     (local.get $91)
    )
    (block $label$7
     (loop $label$8
      (local.set $92
       (i32.load offset=32
        (local.get $3)
       )
      )
      (local.set $93
       (i32.load offset=28
        (local.get $3)
       )
      )
      (local.set $94
       (local.get $92)
      )
      (local.set $95
       (local.get $93)
      )
      (local.set $96
       (i32.lt_s
        (local.get $94)
        (local.get $95)
       )
      )
      (local.set $97
       (i32.const 1)
      )
      (local.set $98
       (i32.and
        (local.get $96)
        (local.get $97)
       )
      )
      (br_if $label$7
       (i32.eqz
        (local.get $98)
       )
      )
      (local.set $99
       (i32.load offset=52
        (local.get $3)
       )
      )
      (local.set $100
       (i32.load offset=32
        (local.get $3)
       )
      )
      (local.set $101
       (i32.const 2)
      )
      (local.set $102
       (i32.shl
        (local.get $100)
        (local.get $101)
       )
      )
      (local.set $103
       (i32.add
        (local.get $99)
        (local.get $102)
       )
      )
      (local.set $104
       (i32.load
        (local.get $103)
       )
      )
      (local.set $105
       (i32.load offset=44
        (local.get $3)
       )
      )
      (local.set $106
       (i32.load offset=32
        (local.get $3)
       )
      )
      (local.set $107
       (i32.const 2)
      )
      (local.set $108
       (i32.shl
        (local.get $106)
        (local.get $107)
       )
      )
      (local.set $109
       (i32.add
        (local.get $105)
        (local.get $108)
       )
      )
      (i32.store
       (local.get $109)
       (local.get $104)
      )
      (local.set $110
       (i32.load offset=32
        (local.get $3)
       )
      )
      (local.set $111
       (i32.const 1)
      )
      (local.set $112
       (i32.add
        (local.get $110)
        (local.get $111)
       )
      )
      (i32.store offset=32
       (local.get $3)
       (local.get $112)
      )
      (br $label$8)
     )
    )
    (local.set $113
     (i32.const 0)
    )
    (i32.store offset=36
     (local.get $3)
     (local.get $113)
    )
    (local.set $114
     (i32.load offset=44
      (local.get $3)
     )
    )
    (local.set $115
     (i32.load
      (local.get $114)
     )
    )
    (i32.store offset=16
     (local.get $3)
     (local.get $115)
    )
    (loop $label$9
     (local.set $116
      (i32.const 1)
     )
     (i32.store offset=32
      (local.get $3)
      (local.get $116)
     )
     (local.set $117
      (i32.load offset=16
       (local.get $3)
      )
     )
     (local.set $118
      (i32.const 1)
     )
     (local.set $119
      (i32.sub
       (local.get $117)
       (local.get $118)
      )
     )
     (i32.store offset=20
      (local.get $3)
      (local.get $119)
     )
     (block $label$10
      (loop $label$11
       (local.set $120
        (i32.load offset=32
         (local.get $3)
        )
       )
       (local.set $121
        (i32.load offset=20
         (local.get $3)
        )
       )
       (local.set $122
        (local.get $120)
       )
       (local.set $123
        (local.get $121)
       )
       (local.set $124
        (i32.lt_s
         (local.get $122)
         (local.get $123)
        )
       )
       (local.set $125
        (i32.const 1)
       )
       (local.set $126
        (i32.and
         (local.get $124)
         (local.get $125)
        )
       )
       (br_if $label$10
        (i32.eqz
         (local.get $126)
        )
       )
       (local.set $127
        (i32.load offset=44
         (local.get $3)
        )
       )
       (local.set $128
        (i32.load offset=32
         (local.get $3)
        )
       )
       (local.set $129
        (i32.const 2)
       )
       (local.set $130
        (i32.shl
         (local.get $128)
         (local.get $129)
        )
       )
       (local.set $131
        (i32.add
         (local.get $127)
         (local.get $130)
        )
       )
       (local.set $132
        (i32.load
         (local.get $131)
        )
       )
       (i32.store offset=12
        (local.get $3)
        (local.get $132)
       )
       (local.set $133
        (i32.load offset=44
         (local.get $3)
        )
       )
       (local.set $134
        (i32.load offset=20
         (local.get $3)
        )
       )
       (local.set $135
        (i32.const 2)
       )
       (local.set $136
        (i32.shl
         (local.get $134)
         (local.get $135)
        )
       )
       (local.set $137
        (i32.add
         (local.get $133)
         (local.get $136)
        )
       )
       (local.set $138
        (i32.load
         (local.get $137)
        )
       )
       (local.set $139
        (i32.load offset=44
         (local.get $3)
        )
       )
       (local.set $140
        (i32.load offset=32
         (local.get $3)
        )
       )
       (local.set $141
        (i32.const 2)
       )
       (local.set $142
        (i32.shl
         (local.get $140)
         (local.get $141)
        )
       )
       (local.set $143
        (i32.add
         (local.get $139)
         (local.get $142)
        )
       )
       (i32.store
        (local.get $143)
        (local.get $138)
       )
       (local.set $144
        (i32.load offset=12
         (local.get $3)
        )
       )
       (local.set $145
        (i32.load offset=44
         (local.get $3)
        )
       )
       (local.set $146
        (i32.load offset=20
         (local.get $3)
        )
       )
       (local.set $147
        (i32.const 2)
       )
       (local.set $148
        (i32.shl
         (local.get $146)
         (local.get $147)
        )
       )
       (local.set $149
        (i32.add
         (local.get $145)
         (local.get $148)
        )
       )
       (i32.store
        (local.get $149)
        (local.get $144)
       )
       (local.set $150
        (i32.load offset=32
         (local.get $3)
        )
       )
       (local.set $151
        (i32.const 1)
       )
       (local.set $152
        (i32.add
         (local.get $150)
         (local.get $151)
        )
       )
       (i32.store offset=32
        (local.get $3)
        (local.get $152)
       )
       (local.set $153
        (i32.load offset=20
         (local.get $3)
        )
       )
       (local.set $154
        (i32.const -1)
       )
       (local.set $155
        (i32.add
         (local.get $153)
         (local.get $154)
        )
       )
       (i32.store offset=20
        (local.get $3)
        (local.get $155)
       )
       (br $label$11)
      )
     )
     (local.set $156
      (i32.load offset=36
       (local.get $3)
      )
     )
     (local.set $157
      (i32.const 1)
     )
     (local.set $158
      (i32.add
       (local.get $156)
       (local.get $157)
      )
     )
     (i32.store offset=36
      (local.get $3)
      (local.get $158)
     )
     (local.set $159
      (i32.load offset=44
       (local.get $3)
      )
     )
     (local.set $160
      (i32.load offset=16
       (local.get $3)
      )
     )
     (local.set $161
      (i32.const 2)
     )
     (local.set $162
      (i32.shl
       (local.get $160)
       (local.get $161)
      )
     )
     (local.set $163
      (i32.add
       (local.get $159)
       (local.get $162)
      )
     )
     (local.set $164
      (i32.load
       (local.get $163)
      )
     )
     (i32.store offset=12
      (local.get $3)
      (local.get $164)
     )
     (local.set $165
      (i32.load offset=16
       (local.get $3)
      )
     )
     (local.set $166
      (i32.load offset=44
       (local.get $3)
      )
     )
     (local.set $167
      (i32.load offset=16
       (local.get $3)
      )
     )
     (local.set $168
      (i32.const 2)
     )
     (local.set $169
      (i32.shl
       (local.get $167)
       (local.get $168)
      )
     )
     (local.set $170
      (i32.add
       (local.get $166)
       (local.get $169)
      )
     )
     (i32.store
      (local.get $170)
      (local.get $165)
     )
     (local.set $171
      (i32.load offset=12
       (local.get $3)
      )
     )
     (i32.store offset=16
      (local.get $3)
      (local.get $171)
     )
     (local.set $172
      (i32.load offset=16
       (local.get $3)
      )
     )
     (br_if $label$9
      (local.get $172)
     )
    )
    (local.set $173
     (i32.load offset=40
      (local.get $3)
     )
    )
    (local.set $174
     (i32.load offset=36
      (local.get $3)
     )
    )
    (local.set $175
     (local.get $173)
    )
    (local.set $176
     (local.get $174)
    )
    (local.set $177
     (i32.lt_s
      (local.get $175)
      (local.get $176)
     )
    )
    (local.set $178
     (i32.const 1)
    )
    (local.set $179
     (i32.and
      (local.get $177)
      (local.get $178)
     )
    )
    (block $label$12
     (br_if $label$12
      (i32.eqz
       (local.get $179)
      )
     )
     (local.set $180
      (i32.load offset=36
       (local.get $3)
      )
     )
     (i32.store offset=40
      (local.get $3)
      (local.get $180)
     )
    )
   )
   (loop $label$13
    (local.set $181
     (i32.load offset=24
      (local.get $3)
     )
    )
    (local.set $182
     (i32.load offset=28
      (local.get $3)
     )
    )
    (local.set $183
     (i32.const 1)
    )
    (local.set $184
     (i32.sub
      (local.get $182)
      (local.get $183)
     )
    )
    (local.set $185
     (local.get $181)
    )
    (local.set $186
     (local.get $184)
    )
    (local.set $187
     (i32.ge_s
      (local.get $185)
      (local.get $186)
     )
    )
    (local.set $188
     (i32.const 1)
    )
    (local.set $189
     (i32.and
      (local.get $187)
      (local.get $188)
     )
    )
    (block $label$14
     (br_if $label$14
      (i32.eqz
       (local.get $189)
      )
     )
     (local.set $190
      (i32.load offset=52
       (local.get $3)
      )
     )
     (call $free
      (local.get $190)
     )
     (local.set $191
      (i32.load offset=44
       (local.get $3)
      )
     )
     (call $free
      (local.get $191)
     )
     (local.set $192
      (i32.load offset=48
       (local.get $3)
      )
     )
     (call $free
      (local.get $192)
     )
     (local.set $193
      (i32.load offset=40
       (local.get $3)
      )
     )
     (local.set $194
      (i32.const 64)
     )
     (local.set $195
      (i32.add
       (local.get $3)
       (local.get $194)
      )
     )
     (global.set $global$0
      (local.get $195)
     )
     (return
      (local.get $193)
     )
    )
    (local.set $196
     (i32.const 0)
    )
    (local.set $197
     (i32.load offset=52
      (local.get $3)
     )
    )
    (local.set $198
     (i32.load
      (local.get $197)
     )
    )
    (i32.store offset=8
     (local.get $3)
     (local.get $198)
    )
    (i32.store offset=32
     (local.get $3)
     (local.get $196)
    )
    (block $label$15
     (loop $label$16
      (local.set $199
       (i32.load offset=32
        (local.get $3)
       )
      )
      (local.set $200
       (i32.load offset=24
        (local.get $3)
       )
      )
      (local.set $201
       (local.get $199)
      )
      (local.set $202
       (local.get $200)
      )
      (local.set $203
       (i32.lt_s
        (local.get $201)
        (local.get $202)
       )
      )
      (local.set $204
       (i32.const 1)
      )
      (local.set $205
       (i32.and
        (local.get $203)
        (local.get $204)
       )
      )
      (br_if $label$15
       (i32.eqz
        (local.get $205)
       )
      )
      (local.set $206
       (i32.load offset=52
        (local.get $3)
       )
      )
      (local.set $207
       (i32.load offset=32
        (local.get $3)
       )
      )
      (local.set $208
       (i32.const 1)
      )
      (local.set $209
       (i32.add
        (local.get $207)
        (local.get $208)
       )
      )
      (local.set $210
       (i32.const 2)
      )
      (local.set $211
       (i32.shl
        (local.get $209)
        (local.get $210)
       )
      )
      (local.set $212
       (i32.add
        (local.get $206)
        (local.get $211)
       )
      )
      (local.set $213
       (i32.load
        (local.get $212)
       )
      )
      (local.set $214
       (i32.load offset=52
        (local.get $3)
       )
      )
      (local.set $215
       (i32.load offset=32
        (local.get $3)
       )
      )
      (local.set $216
       (i32.const 2)
      )
      (local.set $217
       (i32.shl
        (local.get $215)
        (local.get $216)
       )
      )
      (local.set $218
       (i32.add
        (local.get $214)
        (local.get $217)
       )
      )
      (i32.store
       (local.get $218)
       (local.get $213)
      )
      (local.set $219
       (i32.load offset=32
        (local.get $3)
       )
      )
      (local.set $220
       (i32.const 1)
      )
      (local.set $221
       (i32.add
        (local.get $219)
        (local.get $220)
       )
      )
      (i32.store offset=32
       (local.get $3)
       (local.get $221)
      )
      (br $label$16)
     )
    )
    (local.set $222
     (i32.const 0)
    )
    (local.set $223
     (i32.load offset=8
      (local.get $3)
     )
    )
    (local.set $224
     (i32.load offset=52
      (local.get $3)
     )
    )
    (local.set $225
     (i32.load offset=32
      (local.get $3)
     )
    )
    (local.set $226
     (i32.const 2)
    )
    (local.set $227
     (i32.shl
      (local.get $225)
      (local.get $226)
     )
    )
    (local.set $228
     (i32.add
      (local.get $224)
      (local.get $227)
     )
    )
    (i32.store
     (local.get $228)
     (local.get $223)
    )
    (local.set $229
     (i32.load offset=48
      (local.get $3)
     )
    )
    (local.set $230
     (i32.load offset=24
      (local.get $3)
     )
    )
    (local.set $231
     (i32.const 2)
    )
    (local.set $232
     (i32.shl
      (local.get $230)
      (local.get $231)
     )
    )
    (local.set $233
     (i32.add
      (local.get $229)
      (local.get $232)
     )
    )
    (local.set $234
     (i32.load
      (local.get $233)
     )
    )
    (local.set $235
     (i32.const -1)
    )
    (local.set $236
     (i32.add
      (local.get $234)
      (local.get $235)
     )
    )
    (i32.store
     (local.get $233)
     (local.get $236)
    )
    (local.set $237
     (local.get $236)
    )
    (local.set $238
     (local.get $222)
    )
    (local.set $239
     (i32.gt_s
      (local.get $237)
      (local.get $238)
     )
    )
    (local.set $240
     (i32.const 1)
    )
    (local.set $241
     (i32.and
      (local.get $239)
      (local.get $240)
     )
    )
    (block $label$17
     (block $label$18
      (br_if $label$18
       (i32.eqz
        (local.get $241)
       )
      )
      (br $label$17)
     )
     (local.set $242
      (i32.load offset=24
       (local.get $3)
      )
     )
     (local.set $243
      (i32.const 1)
     )
     (local.set $244
      (i32.add
       (local.get $242)
       (local.get $243)
      )
     )
     (i32.store offset=24
      (local.get $3)
      (local.get $244)
     )
     (br $label$13)
    )
   )
   (br $label$3)
  )
 )
 (func $main (type $1) (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 i32)
  (local $19 i32)
  (local $20 i32)
  (local $21 i32)
  (local $22 i32)
  (local $23 i32)
  (local $24 i32)
  (local $25 i32)
  (local $26 i32)
  (local $27 i32)
  (local $28 i32)
  (local $29 i32)
  (local $30 i32)
  (local $31 i32)
  (local $32 i32)
  (local $33 i32)
  (local $34 i32)
  (local $35 i32)
  (local $36 i32)
  (local.set $2
   (global.get $global$0)
  )
  (local.set $3
   (i32.const 32)
  )
  (local.set $4
   (i32.sub
    (local.get $2)
    (local.get $3)
   )
  )
  (global.set $global$0
   (local.get $4)
  )
  (local.set $5
   (i32.const 1)
  )
  (local.set $6
   (i32.const 0)
  )
  (i32.store offset=28
   (local.get $4)
   (local.get $6)
  )
  (i32.store offset=24
   (local.get $4)
   (local.get $0)
  )
  (i32.store offset=20
   (local.get $4)
   (local.get $1)
  )
  (local.set $7
   (i32.load offset=24
    (local.get $4)
   )
  )
  (local.set $8
   (local.get $7)
  )
  (local.set $9
   (local.get $5)
  )
  (local.set $10
   (i32.gt_s
    (local.get $8)
    (local.get $9)
   )
  )
  (local.set $11
   (i32.const 1)
  )
  (local.set $12
   (i32.and
    (local.get $10)
    (local.get $11)
   )
  )
  (block $label$1
   (block $label$2
    (br_if $label$2
     (i32.eqz
      (local.get $12)
     )
    )
    (local.set $13
     (i32.load offset=20
      (local.get $4)
     )
    )
    (local.set $14
     (i32.load offset=4
      (local.get $13)
     )
    )
    (local.set $15
     (call $atoi
      (local.get $14)
     )
    )
    (local.set $16
     (local.get $15)
    )
    (br $label$1)
   )
   (local.set $17
    (i32.const 0)
   )
   (local.set $16
    (local.get $17)
   )
  )
  (local.set $18
   (local.get $16)
  )
  (local.set $19
   (i32.const 1)
  )
  (i32.store offset=16
   (local.get $4)
   (local.get $18)
  )
  (local.set $20
   (i32.load offset=16
    (local.get $4)
   )
  )
  (local.set $21
   (local.get $20)
  )
  (local.set $22
   (local.get $19)
  )
  (local.set $23
   (i32.lt_s
    (local.get $21)
    (local.get $22)
   )
  )
  (local.set $24
   (i32.const 1)
  )
  (local.set $25
   (i32.and
    (local.get $23)
    (local.get $24)
   )
  )
  (block $label$3
   (block $label$4
    (br_if $label$4
     (i32.eqz
      (local.get $25)
     )
    )
    (local.set $26
     (i32.const 1024)
    )
    (local.set $27
     (i32.const 0)
    )
    (drop
     (call $printf
      (local.get $26)
      (local.get $27)
     )
    )
    (local.set $28
     (i32.const 1)
    )
    (i32.store offset=28
     (local.get $4)
     (local.get $28)
    )
    (br $label$3)
   )
   (local.set $29
    (i32.load offset=16
     (local.get $4)
    )
   )
   (local.set $30
    (i32.load offset=16
     (local.get $4)
    )
   )
   (local.set $31
    (call $fannkuch\28int\29
     (local.get $30)
    )
   )
   (i32.store offset=4
    (local.get $4)
    (local.get $31)
   )
   (i32.store
    (local.get $4)
    (local.get $29)
   )
   (local.set $32
    (i32.const 1041)
   )
   (drop
    (call $printf
     (local.get $32)
     (local.get $4)
    )
   )
   (local.set $33
    (i32.const 0)
   )
   (i32.store offset=28
    (local.get $4)
    (local.get $33)
   )
  )
  (local.set $34
   (i32.load offset=28
    (local.get $4)
   )
  )
  (local.set $35
   (i32.const 32)
  )
  (local.set $36
   (i32.add
    (local.get $4)
    (local.get $35)
   )
  )
  (global.set $global$0
   (local.get $36)
  )
  (return
   (local.get $34)
  )
 )
 (func $fannkuch\28int\29 (type $0) (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 i32)
  (local $19 i32)
  (local $20 i32)
  (local $21 i32)
  (local $22 i32)
  (local $23 i32)
  (local $24 i32)
  (local $25 i32)
  (local $26 i32)
  (local $27 i32)
  (local $28 i32)
  (local $29 i32)
  (local $30 i32)
  (local $31 i32)
  (local $32 i32)
  (local $33 i32)
  (local $34 i32)
  (local $35 i32)
  (local $36 i32)
  (local $37 i32)
  (local $38 i32)
  (local $39 i32)
  (local $40 i32)
  (local $41 i32)
  (local $42 i32)
  (local $43 i32)
  (local $44 i32)
  (local $45 i32)
  (local $46 i32)
  (local $47 i32)
  (local $48 i32)
  (local $49 i32)
  (local $50 i32)
  (local $51 i32)
  (local $52 i32)
  (local $53 i32)
  (local $54 i32)
  (local $55 i32)
  (local $56 i32)
  (local $57 i32)
  (local $58 i32)
  (local $59 i32)
  (local $60 i32)
  (local $61 i32)
  (local $62 i32)
  (local $63 i32)
  (local $64 i32)
  (local $65 i32)
  (local $66 i32)
  (local $67 i32)
  (local $68 i32)
  (local $69 i32)
  (local $70 i32)
  (local $71 i32)
  (local $72 i32)
  (local $73 i32)
  (local $74 i32)
  (local $75 i32)
  (local $76 i32)
  (local $77 i32)
  (local $78 i32)
  (local $79 i32)
  (local $80 i32)
  (local $81 i32)
  (local $82 i32)
  (local $83 i32)
  (local $84 i32)
  (local $85 i32)
  (local $86 i32)
  (local $87 i32)
  (local $88 i32)
  (local $89 i32)
  (local $90 i32)
  (local $91 i32)
  (local $92 i32)
  (local $93 i32)
  (local $94 i32)
  (local $95 i32)
  (local $96 i32)
  (local $97 i32)
  (local $98 i32)
  (local $99 i32)
  (local $100 i32)
  (local $101 i32)
  (local $102 i32)
  (local $103 i32)
  (local $104 i32)
  (local $105 i32)
  (local $106 i32)
  (local $107 i32)
  (local $108 i32)
  (local $109 i32)
  (local $110 i32)
  (local $111 i32)
  (local $112 i32)
  (local $113 i32)
  (local $114 i32)
  (local $115 i32)
  (local $116 i32)
  (local $117 i32)
  (local $118 i32)
  (local $119 i32)
  (local $120 i32)
  (local $121 i32)
  (local $122 i32)
  (local $123 i32)
  (local $124 i32)
  (local $125 i32)
  (local $126 i32)
  (local $127 i32)
  (local $128 i32)
  (local $129 i32)
  (local $130 i32)
  (local $131 i32)
  (local $132 i32)
  (local $133 i32)
  (local $134 i32)
  (local $135 i32)
  (local $136 i32)
  (local $137 i32)
  (local $138 i32)
  (local $139 i32)
  (local $140 i32)
  (local $141 i32)
  (local $142 i32)
  (local $143 i32)
  (local $144 i32)
  (local $145 i32)
  (local $146 i32)
  (local $147 i32)
  (local $148 i32)
  (local $149 i32)
  (local $150 i32)
  (local $151 i32)
  (local $152 i32)
  (local $153 i32)
  (local $154 i32)
  (local $155 i32)
  (local $156 i32)
  (local $157 i32)
  (local $158 i32)
  (local $159 i32)
  (local $160 i32)
  (local $161 i32)
  (local $162 i32)
  (local $163 i32)
  (local $164 i32)
  (local $165 i32)
  (local $166 i32)
  (local $167 i32)
  (local $168 i32)
  (local $169 i32)
  (local $170 i32)
  (local $171 i32)
  (local $172 i32)
  (local $173 i32)
  (local $174 i32)
  (local $175 i32)
  (local $176 i32)
  (local $177 i32)
  (local $178 i32)
  (local $179 i32)
  (local.set $1
   (global.get $global$0)
  )
  (local.set $2
   (i32.const 48)
  )
  (local.set $3
   (i32.sub
    (local.get $1)
    (local.get $2)
   )
  )
  (global.set $global$0
   (local.get $3)
  )
  (local.set $4
   (i32.const 0)
  )
  (local.set $5
   (i32.const 30)
  )
  (i32.store offset=44
   (local.get $3)
   (local.get $0)
  )
  (i32.store offset=32
   (local.get $3)
   (local.get $5)
  )
  (i32.store offset=40
   (local.get $3)
   (local.get $4)
  )
  (i32.store offset=20
   (local.get $3)
   (local.get $4)
  )
  (block $label$1
   (loop $label$2
    (local.set $6
     (i32.load offset=20
      (local.get $3)
     )
    )
    (local.set $7
     (i32.load offset=44
      (local.get $3)
     )
    )
    (local.set $8
     (i32.const 1)
    )
    (local.set $9
     (i32.sub
      (local.get $7)
      (local.get $8)
     )
    )
    (local.set $10
     (local.get $6)
    )
    (local.set $11
     (local.get $9)
    )
    (local.set $12
     (i32.lt_s
      (local.get $10)
      (local.get $11)
     )
    )
    (local.set $13
     (i32.const 1)
    )
    (local.set $14
     (i32.and
      (local.get $12)
      (local.get $13)
     )
    )
    (br_if $label$1
     (i32.eqz
      (local.get $14)
     )
    )
    (local.set $15
     (i32.const 12)
    )
    (local.set $16
     (call $malloc
      (local.get $15)
     )
    )
    (i32.store offset=36
     (local.get $3)
     (local.get $16)
    )
    (local.set $17
     (i32.load offset=20
      (local.get $3)
     )
    )
    (local.set $18
     (i32.load offset=36
      (local.get $3)
     )
    )
    (i32.store
     (local.get $18)
     (local.get $17)
    )
    (local.set $19
     (i32.load offset=44
      (local.get $3)
     )
    )
    (local.set $20
     (i32.load offset=36
      (local.get $3)
     )
    )
    (i32.store offset=4
     (local.get $20)
     (local.get $19)
    )
    (local.set $21
     (i32.load offset=40
      (local.get $3)
     )
    )
    (local.set $22
     (i32.load offset=36
      (local.get $3)
     )
    )
    (i32.store offset=8
     (local.get $22)
     (local.get $21)
    )
    (local.set $23
     (i32.load offset=36
      (local.get $3)
     )
    )
    (i32.store offset=40
     (local.get $3)
     (local.get $23)
    )
    (local.set $24
     (i32.load offset=20
      (local.get $3)
     )
    )
    (local.set $25
     (i32.const 1)
    )
    (local.set $26
     (i32.add
      (local.get $24)
      (local.get $25)
     )
    )
    (i32.store offset=20
     (local.get $3)
     (local.get $26)
    )
    (br $label$2)
   )
  )
  (local.set $27
   (i32.const 0)
  )
  (local.set $28
   (i32.load offset=44
    (local.get $3)
   )
  )
  (local.set $29
   (i32.const 2)
  )
  (local.set $30
   (i32.shl
    (local.get $28)
    (local.get $29)
   )
  )
  (local.set $31
   (call $malloc
    (local.get $30)
   )
  )
  (i32.store offset=28
   (local.get $3)
   (local.get $31)
  )
  (local.set $32
   (i32.load offset=44
    (local.get $3)
   )
  )
  (local.set $33
   (i32.const 2)
  )
  (local.set $34
   (i32.shl
    (local.get $32)
    (local.get $33)
   )
  )
  (local.set $35
   (call $malloc
    (local.get $34)
   )
  )
  (i32.store offset=24
   (local.get $3)
   (local.get $35)
  )
  (i32.store offset=20
   (local.get $3)
   (local.get $27)
  )
  (block $label$3
   (loop $label$4
    (local.set $36
     (i32.load offset=20
      (local.get $3)
     )
    )
    (local.set $37
     (i32.load offset=44
      (local.get $3)
     )
    )
    (local.set $38
     (local.get $36)
    )
    (local.set $39
     (local.get $37)
    )
    (local.set $40
     (i32.lt_s
      (local.get $38)
      (local.get $39)
     )
    )
    (local.set $41
     (i32.const 1)
    )
    (local.set $42
     (i32.and
      (local.get $40)
      (local.get $41)
     )
    )
    (br_if $label$3
     (i32.eqz
      (local.get $42)
     )
    )
    (local.set $43
     (i32.load offset=20
      (local.get $3)
     )
    )
    (local.set $44
     (i32.load offset=28
      (local.get $3)
     )
    )
    (local.set $45
     (i32.load offset=20
      (local.get $3)
     )
    )
    (local.set $46
     (i32.const 2)
    )
    (local.set $47
     (i32.shl
      (local.get $45)
      (local.get $46)
     )
    )
    (local.set $48
     (i32.add
      (local.get $44)
      (local.get $47)
     )
    )
    (i32.store
     (local.get $48)
     (local.get $43)
    )
    (local.set $49
     (i32.load offset=20
      (local.get $3)
     )
    )
    (local.set $50
     (i32.const 1)
    )
    (local.set $51
     (i32.add
      (local.get $49)
      (local.get $50)
     )
    )
    (i32.store offset=20
     (local.get $3)
     (local.get $51)
    )
    (br $label$4)
   )
  )
  (local.set $52
   (i32.load offset=44
    (local.get $3)
   )
  )
  (i32.store offset=16
   (local.get $3)
   (local.get $52)
  )
  (block $label$5
   (loop $label$6
    (local.set $53
     (i32.load offset=32
      (local.get $3)
     )
    )
    (block $label$7
     (block $label$8
      (br_if $label$8
       (i32.eqz
        (local.get $53)
       )
      )
      (local.set $54
       (i32.const 0)
      )
      (i32.store offset=20
       (local.get $3)
       (local.get $54)
      )
      (block $label$9
       (loop $label$10
        (local.set $55
         (i32.load offset=20
          (local.get $3)
         )
        )
        (local.set $56
         (i32.load offset=44
          (local.get $3)
         )
        )
        (local.set $57
         (local.get $55)
        )
        (local.set $58
         (local.get $56)
        )
        (local.set $59
         (i32.lt_s
          (local.get $57)
          (local.get $58)
         )
        )
        (local.set $60
         (i32.const 1)
        )
        (local.set $61
         (i32.and
          (local.get $59)
          (local.get $60)
         )
        )
        (br_if $label$9
         (i32.eqz
          (local.get $61)
         )
        )
        (local.set $62
         (i32.load offset=28
          (local.get $3)
         )
        )
        (local.set $63
         (i32.load offset=20
          (local.get $3)
         )
        )
        (local.set $64
         (i32.const 2)
        )
        (local.set $65
         (i32.shl
          (local.get $63)
          (local.get $64)
         )
        )
        (local.set $66
         (i32.add
          (local.get $62)
          (local.get $65)
         )
        )
        (local.set $67
         (i32.load
          (local.get $66)
         )
        )
        (local.set $68
         (i32.const 1)
        )
        (local.set $69
         (i32.add
          (local.get $67)
          (local.get $68)
         )
        )
        (i32.store
         (local.get $3)
         (local.get $69)
        )
        (local.set $70
         (i32.const 1064)
        )
        (drop
         (call $printf
          (local.get $70)
          (local.get $3)
         )
        )
        (local.set $71
         (i32.load offset=20
          (local.get $3)
         )
        )
        (local.set $72
         (i32.const 1)
        )
        (local.set $73
         (i32.add
          (local.get $71)
          (local.get $72)
         )
        )
        (i32.store offset=20
         (local.get $3)
         (local.get $73)
        )
        (br $label$10)
       )
      )
      (local.set $74
       (i32.const 1067)
      )
      (local.set $75
       (i32.const 0)
      )
      (drop
       (call $printf
        (local.get $74)
        (local.get $75)
       )
      )
      (local.set $76
       (i32.load offset=32
        (local.get $3)
       )
      )
      (local.set $77
       (i32.const -1)
      )
      (local.set $78
       (i32.add
        (local.get $76)
        (local.get $77)
       )
      )
      (i32.store offset=32
       (local.get $3)
       (local.get $78)
      )
      (br $label$7)
     )
     (br $label$5)
    )
    (block $label$11
     (loop $label$12
      (local.set $79
       (i32.const 1)
      )
      (local.set $80
       (i32.load offset=16
        (local.get $3)
       )
      )
      (local.set $81
       (local.get $80)
      )
      (local.set $82
       (local.get $79)
      )
      (local.set $83
       (i32.gt_s
        (local.get $81)
        (local.get $82)
       )
      )
      (local.set $84
       (i32.const 1)
      )
      (local.set $85
       (i32.and
        (local.get $83)
        (local.get $84)
       )
      )
      (br_if $label$11
       (i32.eqz
        (local.get $85)
       )
      )
      (local.set $86
       (i32.load offset=16
        (local.get $3)
       )
      )
      (local.set $87
       (i32.load offset=24
        (local.get $3)
       )
      )
      (local.set $88
       (i32.load offset=16
        (local.get $3)
       )
      )
      (local.set $89
       (i32.const 1)
      )
      (local.set $90
       (i32.sub
        (local.get $88)
        (local.get $89)
       )
      )
      (local.set $91
       (i32.const 2)
      )
      (local.set $92
       (i32.shl
        (local.get $90)
        (local.get $91)
       )
      )
      (local.set $93
       (i32.add
        (local.get $87)
        (local.get $92)
       )
      )
      (i32.store
       (local.get $93)
       (local.get $86)
      )
      (local.set $94
       (i32.load offset=16
        (local.get $3)
       )
      )
      (local.set $95
       (i32.const -1)
      )
      (local.set $96
       (i32.add
        (local.get $94)
        (local.get $95)
       )
      )
      (i32.store offset=16
       (local.get $3)
       (local.get $96)
      )
      (br $label$12)
     )
    )
    (loop $label$13
     (local.set $97
      (i32.load offset=16
       (local.get $3)
      )
     )
     (local.set $98
      (i32.load offset=44
       (local.get $3)
      )
     )
     (local.set $99
      (local.get $97)
     )
     (local.set $100
      (local.get $98)
     )
     (local.set $101
      (i32.eq
       (local.get $99)
       (local.get $100)
      )
     )
     (local.set $102
      (i32.const 1)
     )
     (local.set $103
      (i32.and
       (local.get $101)
       (local.get $102)
      )
     )
     (block $label$14
      (br_if $label$14
       (i32.eqz
        (local.get $103)
       )
      )
      (br $label$5)
     )
     (local.set $104
      (i32.const 0)
     )
     (local.set $105
      (i32.load offset=28
       (local.get $3)
      )
     )
     (local.set $106
      (i32.load
       (local.get $105)
      )
     )
     (i32.store offset=4
      (local.get $3)
      (local.get $106)
     )
     (i32.store offset=20
      (local.get $3)
      (local.get $104)
     )
     (block $label$15
      (loop $label$16
       (local.set $107
        (i32.load offset=20
         (local.get $3)
        )
       )
       (local.set $108
        (i32.load offset=16
         (local.get $3)
        )
       )
       (local.set $109
        (local.get $107)
       )
       (local.set $110
        (local.get $108)
       )
       (local.set $111
        (i32.lt_s
         (local.get $109)
         (local.get $110)
        )
       )
       (local.set $112
        (i32.const 1)
       )
       (local.set $113
        (i32.and
         (local.get $111)
         (local.get $112)
        )
       )
       (br_if $label$15
        (i32.eqz
         (local.get $113)
        )
       )
       (local.set $114
        (i32.load offset=28
         (local.get $3)
        )
       )
       (local.set $115
        (i32.load offset=20
         (local.get $3)
        )
       )
       (local.set $116
        (i32.const 1)
       )
       (local.set $117
        (i32.add
         (local.get $115)
         (local.get $116)
        )
       )
       (local.set $118
        (i32.const 2)
       )
       (local.set $119
        (i32.shl
         (local.get $117)
         (local.get $118)
        )
       )
       (local.set $120
        (i32.add
         (local.get $114)
         (local.get $119)
        )
       )
       (local.set $121
        (i32.load
         (local.get $120)
        )
       )
       (local.set $122
        (i32.load offset=28
         (local.get $3)
        )
       )
       (local.set $123
        (i32.load offset=20
         (local.get $3)
        )
       )
       (local.set $124
        (i32.const 2)
       )
       (local.set $125
        (i32.shl
         (local.get $123)
         (local.get $124)
        )
       )
       (local.set $126
        (i32.add
         (local.get $122)
         (local.get $125)
        )
       )
       (i32.store
        (local.get $126)
        (local.get $121)
       )
       (local.set $127
        (i32.load offset=20
         (local.get $3)
        )
       )
       (local.set $128
        (i32.const 1)
       )
       (local.set $129
        (i32.add
         (local.get $127)
         (local.get $128)
        )
       )
       (i32.store offset=20
        (local.get $3)
        (local.get $129)
       )
       (br $label$16)
      )
     )
     (local.set $130
      (i32.const 0)
     )
     (local.set $131
      (i32.load offset=4
       (local.get $3)
      )
     )
     (local.set $132
      (i32.load offset=28
       (local.get $3)
      )
     )
     (local.set $133
      (i32.load offset=20
       (local.get $3)
      )
     )
     (local.set $134
      (i32.const 2)
     )
     (local.set $135
      (i32.shl
       (local.get $133)
       (local.get $134)
      )
     )
     (local.set $136
      (i32.add
       (local.get $132)
       (local.get $135)
      )
     )
     (i32.store
      (local.get $136)
      (local.get $131)
     )
     (local.set $137
      (i32.load offset=24
       (local.get $3)
      )
     )
     (local.set $138
      (i32.load offset=16
       (local.get $3)
      )
     )
     (local.set $139
      (i32.const 2)
     )
     (local.set $140
      (i32.shl
       (local.get $138)
       (local.get $139)
      )
     )
     (local.set $141
      (i32.add
       (local.get $137)
       (local.get $140)
      )
     )
     (local.set $142
      (i32.load
       (local.get $141)
      )
     )
     (local.set $143
      (i32.const -1)
     )
     (local.set $144
      (i32.add
       (local.get $142)
       (local.get $143)
      )
     )
     (i32.store
      (local.get $141)
      (local.get $144)
     )
     (local.set $145
      (local.get $144)
     )
     (local.set $146
      (local.get $130)
     )
     (local.set $147
      (i32.gt_s
       (local.get $145)
       (local.get $146)
      )
     )
     (local.set $148
      (i32.const 1)
     )
     (local.set $149
      (i32.and
       (local.get $147)
       (local.get $148)
      )
     )
     (block $label$17
      (block $label$18
       (br_if $label$18
        (i32.eqz
         (local.get $149)
        )
       )
       (br $label$17)
      )
      (local.set $150
       (i32.load offset=16
        (local.get $3)
       )
      )
      (local.set $151
       (i32.const 1)
      )
      (local.set $152
       (i32.add
        (local.get $150)
        (local.get $151)
       )
      )
      (i32.store offset=16
       (local.get $3)
       (local.get $152)
      )
      (br $label$13)
     )
    )
    (br $label$6)
   )
  )
  (local.set $153
   (i32.const 0)
  )
  (local.set $154
   (i32.load offset=28
    (local.get $3)
   )
  )
  (call $free
   (local.get $154)
  )
  (local.set $155
   (i32.load offset=24
    (local.get $3)
   )
  )
  (call $free
   (local.get $155)
  )
  (i32.store offset=12
   (local.get $3)
   (local.get $153)
  )
  (block $label$19
   (loop $label$20
    (local.set $156
     (i32.const 0)
    )
    (local.set $157
     (i32.load offset=40
      (local.get $3)
     )
    )
    (local.set $158
     (local.get $157)
    )
    (local.set $159
     (local.get $156)
    )
    (local.set $160
     (i32.ne
      (local.get $158)
      (local.get $159)
     )
    )
    (local.set $161
     (i32.const 1)
    )
    (local.set $162
     (i32.and
      (local.get $160)
      (local.get $161)
     )
    )
    (br_if $label$19
     (i32.eqz
      (local.get $162)
     )
    )
    (local.set $163
     (i32.load offset=40
      (local.get $3)
     )
    )
    (local.set $164
     (call $fannkuch_worker\28void*\29
      (local.get $163)
     )
    )
    (i32.store offset=8
     (local.get $3)
     (local.get $164)
    )
    (local.set $165
     (i32.load offset=12
      (local.get $3)
     )
    )
    (local.set $166
     (i32.load offset=8
      (local.get $3)
     )
    )
    (local.set $167
     (local.get $165)
    )
    (local.set $168
     (local.get $166)
    )
    (local.set $169
     (i32.lt_s
      (local.get $167)
      (local.get $168)
     )
    )
    (local.set $170
     (i32.const 1)
    )
    (local.set $171
     (i32.and
      (local.get $169)
      (local.get $170)
     )
    )
    (block $label$21
     (br_if $label$21
      (i32.eqz
       (local.get $171)
      )
     )
     (local.set $172
      (i32.load offset=8
       (local.get $3)
      )
     )
     (i32.store offset=12
      (local.get $3)
      (local.get $172)
     )
    )
    (local.set $173
     (i32.load offset=40
      (local.get $3)
     )
    )
    (i32.store offset=36
     (local.get $3)
     (local.get $173)
    )
    (local.set $174
     (i32.load offset=40
      (local.get $3)
     )
    )
    (local.set $175
     (i32.load offset=8
      (local.get $174)
     )
    )
    (i32.store offset=40
     (local.get $3)
     (local.get $175)
    )
    (local.set $176
     (i32.load offset=36
      (local.get $3)
     )
    )
    (call $free
     (local.get $176)
    )
    (br $label$20)
   )
  )
  (local.set $177
   (i32.load offset=12
    (local.get $3)
   )
  )
  (local.set $178
   (i32.const 48)
  )
  (local.set $179
   (i32.add
    (local.get $3)
    (local.get $178)
   )
  )
  (global.set $global$0
   (local.get $179)
  )
  (return
   (local.get $177)
  )
 )
 ;; custom section ".debug_info", size 640
 ;; custom section ".debug_ranges", size 32
 ;; custom section ".debug_abbrev", size 222
 ;; custom section ".debug_line", size 1558
 ;; custom section ".debug_str", size 409
 ;; custom section "producers", size 180
)
