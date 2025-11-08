;; contracts/EnergyInnovateCore.clar
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-ALREADY-EXISTS u101)
(define-constant ERR-NOT-FOUND u102)
(define-constant ERR-INVALID-HASH u103)
(define-constant ERR-INVALID-CATEGORY u104)
(define-constant ERR-INVALID-STATUS u105)
(define-constant ERR-INSUFFICIENT-FEE u106)
(define-constant ERR-EXPERT-ONLY u107)
(define-constant ERR-VERIFICATION-CLOSED u108)
(define-constant ERR-QUORUM-NOT-MET u109)
(define-constant ERR-ALREADY-VOTED u110)
(define-constant ERR-INVALID-ROYALTY u111)
(define-constant ERR-ACCESS-DENIED u112)

(define-constant FEE-ACCESS u1000000)
(define-constant QUORUM-PCT u70)
(define-constant MIN-EXPERTS u3)
(define-constant ROYALTY-PCT u10)

(define-data-var next-idea-id uint u0)
(define-data-var platform-owner principal tx-sender)
(define-data-var total-fees-collected uint u0)

(define-map ideas
  uint
  {
    title: (string-ascii 80),
    description: (string-utf8 1000),
    file-hash: (buff 32),
    category: uint,
    submitter: principal,
    timestamp: uint,
    status: (string-ascii 20),
    access-count: uint
  }
)

(define-map idea-experts uint (list 10 principal))
(define-map expert-votes {idea-id: uint, expert: principal} {approve: bool, reasoning: (string-utf8 280)})
(define-map expert-reputation principal uint)
(define-map royalties-pending principal uint)

(define-read-only (get-idea (id uint))
  (map-get? ideas id)
)

(define-read-only (get-vote (idea-id uint) (expert principal))
  (map-get? expert-votes {idea-id: idea-id, expert: expert})
)

(define-read-only (get-royalties (expert principal))
  (default-to u0 (map-get? royalties-pending expert))
)

(define-read-only (is-expert (who principal))
  (>= (default-to u0 (map-get? expert-reputation who)) u50)
)

(define-private (valid-hash (h (buff 32)))
  (is-some (index-of h 0x))
)

(define-private (valid-category (c uint))
  (and (>= c u1) (<= c u5))
)

(define-private (quorum-met (approvals uint) (total uint))
  (if (is-eq total u0)
      false
      (>= (* approvals u100) (* total QUORUM-PCT))
  )
)

(define-public (register-expert)
  (let ((rep (default-to u0 (map-get? expert-reputation tx-sender))))
    (ok (map-set expert-reputation tx-sender (if (is-eq rep u0) u50 rep)))
  )
)

(define-public (submit-idea
    (title (string-ascii 80))
    (description (string-utf8 1000))
    (file-hash (buff 32))
    (category uint))
  (let ((idea-id (var-get next-idea-id)))
    (asserts! (valid-hash file-hash) (err ERR-INVALID-HASH))
    (asserts! (valid-category category) (err ERR-INVALID-CATEGORY))
    (asserts! (is-none (map-get? ideas idea-id)) (err ERR-ALREADY-EXISTS))
    (map-set ideas idea-id
      {
        title: title,
        description: description,
        file-hash: file-hash,
        category: category,
        submitter: tx-sender,
        timestamp: block-height,
        status: "pending",
        access-count: u0
      }
    )
    (var-set next-idea-id (+ idea-id u1))
    (print {event: "idea-submitted", id: idea-id})
    (ok idea-id)
  )
)

(define-public (assign-experts (idea-id uint) (experts (list 10 principal)))
  (let ((idea (unwrap! (map-get? ideas idea-id) (err ERR-NOT-FOUND))))
    (asserts! (is-eq tx-sender (var-get platform-owner)) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-eq (get status idea) "pending") (err ERR-VERIFICATION-CLOSED))
    (asserts! (>= (len experts) MIN-EXPERTS) (err ERR-EXPERT-ONLY))
    (map-set idea-experts idea-id experts)
    (ok true)
  )
)

(define-public (verify-idea (idea-id uint) (approve bool) (reasoning (string-utf8 280)))
  (let (
         (idea (unwrap! (map-get? ideas idea-id) (err ERR-NOT-FOUND)))
         (experts (default-to (list) (map-get? idea-experts idea-id)))
         (vote-key {idea-id: idea-id, expert: tx-sender})
       )
    (asserts! (is-expert tx-sender) (err ERR-EXPERT-ONLY))
    (asserts! (is-some (index-of experts tx-sender)) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-eq (get status idea) "pending") (err ERR-VERIFICATION-CLOSED))
    (asserts! (is-none (map-get? expert-votes vote-key)) (err ERR-ALREADY-VOTED))
    (map-set expert-votes vote-key {approve: approve, reasoning: reasoning})
    (let (
           (votes (fold check-vote experts u0))
           (total (len experts))
           (approvals (get approvals votes))
         )
      (if (quorum-met approvals total)
          (begin
            (map-set ideas idea-id (merge idea {
              status: (if approve "verified" "rejected"),
              access-count: (get access-count idea)
            }))
            (if approve
                (try! (distribute-royalty idea-id experts))
                (ok false))
            (ok true)
          )
          (ok false)
      )
    )
  )
)

(define-private (check-vote (expert principal) (acc {approvals: uint, total: uint}))
  (let ((vote (map-get? expert-votes {idea-id: (get idea-id acc), expert: expert})))
    (match vote
      v (if (get approve v)
          {approvals: (+ (get approvals acc) u1), total: (+ (get total acc) u1)}
          {approvals: (get approvals acc), total: (+ (get total acc) u1)})
      {approvals: (get approvals acc), total: (+ (get total acc) u1)}
    )
  )
)

(define-private (distribute-royalty (idea-id uint) (experts (list 10 principal)))
  (let ((per-expert (/ (* FEE-ACCESS ROYALTY-PCT) u100)))
    (fold distribute-to-expert experts {idea-id: idea-id, amount: per-expert})
  )
)

(define-private (distribute-to-expert (expert principal) (ctx {idea-id: uint, amount: uint}))
  (let ((pending (default-to u0 (map-get? royalties-pending expert))))
    (map-set royalties-pending expert (+ pending (get amount ctx)))
    (ok true)
  )
)

(define-public (access-idea (idea-id uint))
  (let ((idea (unwrap! (map-get? ideas idea-id) (err ERR-NOT-FOUND))))
    (asserts! (is-eq (get status idea) "verified") (err ERR-ACCESS-DENIED))
    (try! (stx-transfer? FEE-ACCESS tx-sender (var-get platform-owner)))
    (var-set total-fees-collected (+ (var-get total-fees-collected) FEE-ACCESS))
    (map-set ideas idea-id (merge idea {access-count: (+ (get access-count idea) u1)}))
    (let ((experts (default-to (list) (map-get? idea-experts idea-id))))
      (try! (distribute-royalty idea-id experts))
    )
    (ok true)
  )
)

(define-public (claim-royalties)
  (let ((amount (default-to u0 (map-get? royalties-pending tx-sender))))
    (asserts! (> amount u0) (err ERR-INVALID-ROYALTY))
    (map-delete royalties-pending tx-sender)
    (try! (stx-transfer? amount (var-get platform-owner) tx-sender))
    (ok amount)
  )
)

(define-public (update-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get platform-owner)) (err ERR-NOT-AUTHORIZED))
    (var-set platform-owner new-owner)
    (ok true)
  )
)