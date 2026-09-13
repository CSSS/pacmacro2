package api

// Set defines a generic type using a map with empty structs.
type Set[T comparable] map[T]struct{}

// NewSet initializes a set with optional starting elements.
func NewSet[T comparable](elements ...T) Set[T] {
	s := make(Set[T])
	for _, el := range elements {
		s.Add(el)
	}
	return s
}

// Add inserts an element into the set.
func (s Set[T]) Add(element T) {
	s[element] = struct{}{}
}

// Remove deletes an element from the set.
func (s Set[T]) Remove(element T) {
	delete(s, element)
}

// Has checks if an element exists in the set.
func (s Set[T]) Has(element T) bool {
	_, exists := s[element]
	return exists
}

// Size returns the number of elements.
func (s Set[T]) Size() int {
	return len(s)
}
